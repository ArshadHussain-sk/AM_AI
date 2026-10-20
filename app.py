import os
import sys
import uuid
import json
import re
import queue
import shutil
import threading
import time
import glob
from typing import Dict, Any, Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.templating import Jinja2Templates
from fastapi import Request
from starlette.middleware.sessions import SessionMiddleware
import database

# Check PyTorch and CUDA availability gracefully
cuda_available = False
torch_version = "Not Installed"
gpu_device_name = "Not Detected"
gpu_vram_gb = 0.0
gpu_device_count = 0

try:
    import torch
    cuda_available = torch.cuda.is_available()
    torch_version = torch.__version__
    if cuda_available:
        gpu_device_count = torch.cuda.device_count()
        gpu_device_name = torch.cuda.get_device_name(0)
        gpu_vram_gb = round(torch.cuda.get_device_properties(0).total_memory / (1024**3), 1)
except Exception:
    pass

# Check FFmpeg availability
has_ffmpeg = shutil.which("ffmpeg") is not None

# Directories
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
OUTPUT_DIR = os.path.join(BASE_DIR, "outputs")

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Initialize database schema
database.init_db()

# Job State & Queue
jobs: Dict[str, Dict[str, Any]] = {}
job_queue = queue.Queue()

# Load history from database on startup
def load_history():
    global jobs
    try:
        conn = database.get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM jobs")
        db_jobs = cursor.fetchall()
        for job in db_jobs:
            job_dict = dict(job)
            cursor.execute("SELECT * FROM stems WHERE job_id = ?", (job_dict["job_id"],))
            stems = cursor.fetchone()
            job_dict["stems"] = dict(stems) if stems else {}
            
            # Reset processing/queued status to failed if server restarted mid-job
            if job_dict["status"] in ["queued", "processing"]:
                job_dict["status"] = "failed"
                job_dict["error"] = "Job interrupted by server restart"
                database.update_job_status(job_dict["job_id"], "failed", job_dict["progress"], job_dict["error"])
            
            # Reconstruct local filepath
            ext = job_dict["ext"]
            job_dict["filepath"] = os.path.join(UPLOAD_DIR, job_dict["job_id"], f"original.{ext}")
            jobs[job_dict["job_id"]] = job_dict
        conn.close()
        print(f"Loaded {len(db_jobs)} jobs from SQLite database.")
    except Exception as e:
        print(f"Error loading history from SQLite: {e}")
        jobs = {}

load_history()

# Setup FastAPI
app = FastAPI(title="AM AI Audio Lab")

# Configurable GitHub Profile Link
GITHUB_URL = "https://github.com/ArshadHussain-sk"

# Add Session Middleware for secure cookie authentication
app.add_middleware(
    SessionMiddleware, 
    secret_key=os.environ.get("SESSION_SECRET_KEY", "am_ai_labs_super_secure_signed_session_cookie_key_987654321")
)

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount Static Files & Templates
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/outputs", StaticFiles(directory=OUTPUT_DIR), name="outputs")

templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

# Audio Duration Extractor Helper
def get_audio_duration(file_path: str) -> float:
    ext = os.path.splitext(file_path)[1].lower()
    try:
        # Try soundfile first (good for WAV, FLAC, OGG)
        import soundfile as sf
        info = sf.info(file_path)
        return info.duration
    except Exception:
        try:
            # Try mutagen for MP3, M4A
            if ext == '.mp3':
                from mutagen.mp3 import MP3
                audio = MP3(file_path)
                return audio.info.length
            elif ext in ['.m4a', '.mp4']:
                from mutagen.mp4 import MP4
                audio = MP4(file_path)
                return audio.info.length
        except Exception:
            pass
    
    # Fallback to ffprobe if available
    if has_ffmpeg:
        try:
            import subprocess
            cmd = [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", file_path
            ]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
            return float(res.stdout.strip())
        except Exception:
            pass
            
    return 0.0

# Stems Instrumental Mix Helper (Sum of all non-vocal stems)
def mix_instrumental(stem_paths: list, out_path: str) -> bool:
    try:
        import soundfile as sf
        import numpy as np
        
        data_list = []
        sr = None
        
        for p in stem_paths:
            if p and os.path.exists(p):
                data, samplerate = sf.read(p)
                if sr is None:
                    sr = samplerate
                data_list.append(data)
        
        if not data_list:
            return False
            
        # Standardize lengths
        min_len = min(len(d) for d in data_list)
        # Check channels (mono vs stereo)
        num_channels = data_list[0].shape[1] if len(data_list[0].shape) > 1 else 1
        
        mixed = np.zeros((min_len, num_channels))
        for d in data_list:
            # Normalize channel dimensions
            d_channels = d.shape[1] if len(d.shape) > 1 else 1
            if num_channels == 2 and d_channels == 1:
                # convert mono to stereo
                d_expanded = np.column_stack((d[:min_len], d[:min_len]))
                mixed += d_expanded
            else:
                mixed += d[:min_len, :num_channels]
                
        # Clip to prevent digital distortion
        mixed = np.clip(mixed, -1.0, 1.0)
        sf.write(out_path, mixed, sr)
        return True
    except Exception as e:
        print(f"Error mixing instrumental: {e}")
        return False

# Stems Audio Post-Processing (Normalization + Adaptive Noise Gate)
def post_process_audio(filepath: str, normalize: bool, noise_gate: bool) -> bool:
    try:
        import soundfile as sf
        import numpy as np
        
        if not os.path.exists(filepath):
            return False
            
        data, samplerate = sf.read(filepath)
        
        # 1. Apply Adaptive Noise Gate (process before boosting gains to keep noise floor low)
        if noise_gate:
            # Threshold at -55dBFS -> 10**( -55 / 20 ) = 0.0018 absolute amplitude
            threshold = 0.0018
            abs_data = np.abs(data)
            
            # For stereo audio, evaluate envelope max across both channels
            if len(data.shape) > 1:
                channel_max = np.max(abs_data, axis=1)
                mask_noise = channel_max < threshold
                mask_silence = channel_max < (threshold * 0.4)
                
                data[mask_noise] = data[mask_noise] * 0.15 # Attenuate low rumble/hiss
                data[mask_silence] = 0.0 # Force absolute silence on very quiet gaps
            else:
                mask_noise = abs_data < threshold
                mask_silence = abs_data < (threshold * 0.4)
                
                data[mask_noise] = data[mask_noise] * 0.15
                data[mask_silence] = 0.0
                
        # 2. Apply Smart Normalization
        if normalize:
            peak = np.max(np.abs(data))
            if peak > 0.0001:
                # Target peak: -1.0 dBFS = 0.891
                target_peak = 0.891
                data = data * (target_peak / peak)
                
        # Safeguard against digital clipping distortion
        data = np.clip(data, -1.0, 1.0)
                
        # Save back the post-processed lossless WAV file
        sf.write(filepath, data, samplerate)
        return True
    except Exception as e:
        print(f"Error during audio post-processing of {filepath}: {e}")
        return False

# Manual High Quality 320kbps MP3 Encoder
def encode_wav_to_mp3(wav_path: str) -> str:
    if not has_ffmpeg or not os.path.exists(wav_path):
        return wav_path
        
    import subprocess
    mp3_path = os.path.splitext(wav_path)[0] + ".mp3"
    
    # Run FFmpeg to encode to 320kbps MP3
    cmd = ["ffmpeg", "-y", "-i", wav_path, "-b:a", "320k", mp3_path]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    
    if res.returncode == 0 and os.path.exists(mp3_path) and os.path.getsize(mp3_path) > 0:
        try:
            os.remove(wav_path)
        except Exception:
            pass
        return mp3_path
    return wav_path

# Demucs Worker Runner
def run_separation(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return
        
    job["status"] = "processing"
    job["progress"] = 5
    database.update_job_status(job_id, "processing", 5)
    
    in_file = job["filepath"]
    mode = job["mode"]
    device_choice = job["device"]
    model_name = job.get("model", "htdemucs")
    
    # Enforce 6-stem model for 6stems separation
    if mode == "6stems":
        model_name = "htdemucs_6s"
    
    # Select execution device
    target_device = "cpu"
    if device_choice == "auto":
        target_device = "cuda" if cuda_available else "cpu"
    elif device_choice == "cuda" or device_choice == "gpu":
        target_device = "cuda" if cuda_available else "cpu"
    
    job_out_dir = os.path.join(OUTPUT_DIR, job_id)
    os.makedirs(job_out_dir, exist_ok=True)
    
    # Build Demucs command (Force demucs to write WAV outputs losslessly)
    cmd = [sys.executable, "-m", "demucs", "-n", model_name, "-d", target_device, "-o", job_out_dir]
    
    # Enable memory-safe chunking on GPU (safeguards 6GB VRAM on RTX 4050 from OOM)
    if target_device == "cuda":
        cmd.extend(["--segment", "7"])

    if mode == "2stems":
        cmd.extend(["--two-stems", "vocals"])
        
    cmd.append(in_file)
    
    print(f"Executing Demucs job {job_id} command: {' '.join(cmd)}")
    
    try:
        # Start Demucs subprocess and capture progress via stderr (tqdm)
        process = subprocess_run(cmd, job_id)
        if process != 0:
            raise Exception("Demucs separation failed with non-zero exit code.")
            
        # Scan for output files recursively (these will be WAV stems)
        output_files = glob.glob(os.path.join(job_out_dir, "**", "*.wav"), recursive=True)
        print(f"Job {job_id} complete. Found WAV stems: {output_files}")
        
        # Locate stems
        vocals_path = None
        instrumental_path = None
        drums_path = None
        bass_path = None
        other_path = None
        guitar_path = None
        piano_path = None
        
        for f in output_files:
            fname = os.path.basename(f).lower()
            if "no_vocals" in fname:
                instrumental_path = f
            elif "vocals" in fname:
                vocals_path = f
            elif "drums" in fname:
                drums_path = f
            elif "bass" in fname:
                bass_path = f
            elif "guitar" in fname:
                guitar_path = f
            elif "piano" in fname:
                piano_path = f
            elif "other" in fname:
                other_path = f
                
        # Handle instrumental synthesis for multi-stem modes (4stems or 6stems)
        if mode in ["4stems", "6stems"] and not instrumental_path:
            instrumental_path = os.path.join(job_out_dir, model_name, "original", "no_vocals.wav")
            os.makedirs(os.path.dirname(instrumental_path), exist_ok=True)
            
            stems_to_mix = []
            for path in [drums_path, bass_path, other_path, guitar_path, piano_path]:
                if path:
                    stems_to_mix.append(path)
                    
            success = mix_instrumental(stems_to_mix, instrumental_path)
            if not success:
                instrumental_path = None

        # Fetch quality parameters from job config
        normalize = job.get("normalize", True)
        noise_gate = job.get("noise_gate", False)

        # Apply post-processing (normalization + noise gate) and transcode to 320kbps MP3
        all_wavs = glob.glob(os.path.join(job_out_dir, "**", "*.wav"), recursive=True)
        for w in all_wavs:
            # Post-process WAV
            post_process_audio(w, normalize, noise_gate)
            # Transcode WAV to MP3 if FFmpeg is available (deletes original WAV)
            encode_wav_to_mp3(w)

        # Re-scan output files to map final formats (MP3/WAV)
        final_files = glob.glob(os.path.join(job_out_dir, "**", "*.*"), recursive=True)
        final_files = [f for f in final_files if os.path.isfile(f) and not f.endswith(".zip")]
        
        vocals_path = None
        instrumental_path = None
        drums_path = None
        bass_path = None
        other_path = None
        guitar_path = None
        piano_path = None
        
        for f in final_files:
            fname = os.path.basename(f).lower()
            if "no_vocals" in fname:
                instrumental_path = f
            elif "vocals" in fname:
                vocals_path = f
            elif "drums" in fname:
                drums_path = f
            elif "bass" in fname:
                bass_path = f
            elif "guitar" in fname:
                guitar_path = f
            elif "piano" in fname:
                piano_path = f
            elif "other" in fname:
                other_path = f
                
        # Resolve relative URLs
        def get_rel_url(abs_path):
            if not abs_path:
                return None
            rel = os.path.relpath(abs_path, BASE_DIR)
            return "/" + rel.replace("\\", "/")

        job["stems"] = {
            "vocals": get_rel_url(vocals_path),
            "instrumental": get_rel_url(instrumental_path),
            "drums": get_rel_url(drums_path),
            "bass": get_rel_url(bass_path),
            "other": get_rel_url(other_path),
            "guitar": get_rel_url(guitar_path),
            "piano": get_rel_url(piano_path)
        }
        
        # Verify that the primary stems were generated
        if not vocals_path or not instrumental_path:
            raise Exception("Failed to generate separation stems. Output files missing.")
            
        job["status"] = "finished"
        job["progress"] = 100
        job["error"] = None
        
        database.save_job_stems(job_id, job["stems"])
        database.update_job_status(job_id, "finished", 100, None)
        
    except Exception as e:
        print(f"Demucs execution error: {e}")
        job["status"] = "failed"
        job["error"] = str(e)
        database.update_job_status(job_id, "failed", job.get("progress", 0), str(e))

def subprocess_run(cmd, job_id) -> int:
    import subprocess
    # Run Demucs subprocess
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        encoding='utf-8',
        errors='replace'
    )
    
    # Monitor progress from stderr
    buffer = ""
    while True:
        char = process.stderr.read(1)
        if not char:
            break
        if char == '\r' or char == '\n':
            # Look for progress percentages in stderr buffer
            # Demucs tqdm format looks like: 54%|█████▍    | 54.2/100.0 [00:12<00:10]
            match = re.search(r"(\d+)%", buffer)
            if match:
                pct = int(match.group(1))
                # Map 0-100% of demucs separation to 10-95% of job progress
                progress = int(10 + (pct * 0.85))
                if jobs[job_id]["progress"] != progress:
                    jobs[job_id]["progress"] = progress
                    database.update_job_status(job_id, "processing", progress)
            buffer = ""
        else:
            buffer += char
            
    return process.wait()

# Sequential Queue Worker Thread
def queue_worker():
    while True:
        job_id = job_queue.get()
        if job_id is None:
            break
        try:
            run_separation(job_id)
        except Exception as e:
            print(f"Worker exception: {e}")
        finally:
            job_queue.task_done()

# Start Worker Thread on launch
worker_thread = threading.Thread(target=queue_worker, daemon=True)
worker_thread.start()

# Periodic Auto-Cleanup of old files (older than 24 hours)
def cleanup_old_jobs():
    now = time.time()
    day_sec = 24 * 60 * 60
    jobs_to_delete = []
    
    for job_id, job in list(jobs.items()):
        try:
            created_at = job.get("created_at", 0)
            if now - created_at > day_sec:
                # Delete files
                up_dir = os.path.join(UPLOAD_DIR, job_id)
                out_dir = os.path.join(OUTPUT_DIR, job_id)
                if os.path.exists(up_dir):
                    shutil.rmtree(up_dir, ignore_errors=True)
                if os.path.exists(out_dir):
                    shutil.rmtree(out_dir, ignore_errors=True)
                jobs_to_delete.append(job_id)
        except Exception as e:
            print(f"Error cleaning up job {job_id}: {e}")
            
    if jobs_to_delete:
        for job_id in jobs_to_delete:
            jobs.pop(job_id, None)
            try:
                conn = database.get_db_connection()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM jobs WHERE job_id = ?", (job_id,))
                conn.commit()
                conn.close()
            except Exception:
                pass
        print(f"Cleaned up {len(jobs_to_delete)} expired jobs from disk and history.")

# Run cleanup periodically in a background thread to prevent disk leakage
def start_cleanup_scheduler():
    def run_forever():
        # Initial sweep delay after boot
        time.sleep(10)
        while True:
            try:
                cleanup_old_jobs()
            except Exception as e:
                print(f"Cleanup scheduler exception: {e}")
            time.sleep(3600) # Run sweep every hour
            
    threading.Thread(target=run_forever, daemon=True).start()

start_cleanup_scheduler()

# API: GET index
@app.get("/")
def read_root(request: Request):
    user_id = request.session.get("user_id")
    if not user_id:
        from fastapi.responses import RedirectResponse
        return RedirectResponse("/login", status_code=303)
        
    return templates.TemplateResponse("index.html", {
        "request": request,
        "username": request.session.get("username", "User"),
        "cuda_available": cuda_available,
        "torch_version": torch_version,
        "gpu_device_name": gpu_device_name,
        "gpu_vram_gb": gpu_vram_gb,
        "has_ffmpeg": has_ffmpeg,
        "github_url": GITHUB_URL
    })

# API: GET System Hardware Telemetry
@app.get("/api/system/telemetry")
def get_system_telemetry(request: Request):
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return {
        "cuda_available": cuda_available,
        "torch_version": torch_version,
        "gpu_device_name": gpu_device_name,
        "gpu_vram_gb": gpu_vram_gb,
        "gpu_device_count": gpu_device_count,
        "has_ffmpeg": has_ffmpeg,
        "models_available": ["htdemucs", "htdemucs_ft", "mdx_extra", "htdemucs_6s"],
        "os": sys.platform,
        "python_version": sys.version.split(" ")[0]
    }

# AUTHENTICATION API ROUTES
@app.get("/login")
def login_get(request: Request):
    if request.session.get("user_id"):
        from fastapi.responses import RedirectResponse
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse("login.html", {"request": request, "error": None})

@app.post("/login")
def login_post(request: Request, username: str = Form(...), password: str = Form(...)):
    user = database.authenticate_user(username, password)
    if user:
        request.session["user_id"] = user["id"]
        request.session["username"] = user["username"]
        from fastapi.responses import RedirectResponse
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse("login.html", {"request": request, "error": "Invalid username or password"})

@app.get("/register")
def register_get(request: Request):
    if request.session.get("user_id"):
        from fastapi.responses import RedirectResponse
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse("register.html", {"request": request, "error": None})

@app.post("/register")
def register_post(request: Request, username: str = Form(...), password: str = Form(...), confirm_password: str = Form(...)):
    if password != confirm_password:
        return templates.TemplateResponse("register.html", {"request": request, "error": "Passwords do not match"})
    user_id = database.create_user(username, password)
    if user_id != -1:
        request.session["user_id"] = user_id
        request.session["username"] = username.strip().lower()
        from fastapi.responses import RedirectResponse
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse("register.html", {"request": request, "error": "Username already exists"})

@app.get("/logout")
def logout(request: Request):
    request.session.clear()
    from fastapi.responses import RedirectResponse
    return RedirectResponse("/login", status_code=303)

# API: POST /upload
@app.post("/upload")
async def upload_audio(request: Request, file: UploadFile = File(...)):
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Unauthorized")
        
    # Verify file extension
    ext = os.path.splitext(file.filename)[1].lower()[1:]
    supported = ["mp3", "wav", "flac", "m4a", "ogg"]
    if ext not in supported:
        raise HTTPException(status_code=400, detail=f"Unsupported format. Supported: {', '.join(supported)}")
        
    job_id = str(uuid.uuid4())
    job_upload_dir = os.path.join(UPLOAD_DIR, job_id)
    os.makedirs(job_upload_dir, exist_ok=True)
    
    filename_clean = f"original.{ext}"
    filepath = os.path.join(job_upload_dir, filename_clean)
    
    # Save file and verify size
    size = 0
    try:
        with open(filepath, "wb") as buffer:
            while chunk := await file.read(1024 * 1024): # 1MB chunks
                size += len(chunk)
                if size > 500 * 1024 * 1024: # 500 MB
                    buffer.close()
                    shutil.rmtree(job_upload_dir, ignore_errors=True)
                    raise HTTPException(status_code=413, detail="File too large. Max size limit is 500MB.")
                buffer.write(chunk)
    except HTTPException:
        raise
    except Exception as e:
        shutil.rmtree(job_upload_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"File save error: {str(e)}")

    duration = get_audio_duration(filepath)
    
    # Save job metadata to DB
    database.add_job(
        job_id=job_id,
        user_id=user_id,
        filename=file.filename,
        ext=ext,
        size=size,
        duration=duration,
        mode="2stems",
        model="htdemucs",
        normalize=True,
        noise_gate=False
    )
    
    # Save job metadata to memory cache
    jobs[job_id] = {
        "job_id": job_id,
        "user_id": user_id,
        "filename": file.filename,
        "ext": ext,
        "size": size,
        "duration": duration,
        "filepath": filepath,
        "status": "uploaded",
        "progress": 0,
        "mode": "2stems",
        "device": "auto",
        "created_at": time.time(),
        "stems": {},
        "error": None
    }
    
    return {
        "job_id": job_id,
        "filename": file.filename,
        "duration": duration,
        "size": size,
        "original_url": f"/uploads/{job_id}/{filename_clean}"
    }

# API: POST /separate/{job}
@app.post("/separate/{job_id}")
async def separate_audio(
    request: Request,
    job_id: str,
    mode: str = Form("2stems"),
    device: str = Form("auto"),
    model: str = Form("htdemucs"),
    normalize: bool = Form(True),
    noise_gate: bool = Form(False)
):
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Unauthorized")
        
    job = jobs.get(job_id)
    if not job or job.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="Job not found.")
        
    if job["status"] in ["queued", "processing"]:
        return {"status": job["status"], "progress": job["progress"]}
        
    job["status"] = "queued"
    job["progress"] = 0
    job["mode"] = mode
    job["device"] = device
    job["model"] = model
    job["normalize"] = normalize
    job["noise_gate"] = noise_gate
    job["error"] = None
    
    database.update_job_status(job_id, "queued", 0, None)
    
    job_queue.put(job_id)
    return {"status": "queued", "progress": 0}

# API: GET /status/{job}
@app.get("/status/{job_id}")
def get_status(request: Request, job_id: str):
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Unauthorized")
        
    job = jobs.get(job_id)
    if not job or job.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="Job not found.")
        
    response_data = {
        "job_id": job["job_id"],
        "filename": job["filename"],
        "status": job["status"],
        "progress": job["progress"],
        "mode": job["mode"],
        "duration": job["duration"],
        "size": job["size"],
        "stems": job["stems"],
        "error": job["error"]
    }
    return response_data

# API: GET /download/vocals/{job}
@app.get("/download/vocals/{job_id}")
def download_vocals(request: Request, job_id: str):
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Unauthorized")
        
    job = jobs.get(job_id)
    if not job or job.get("user_id") != user_id or job["status"] != "finished":
        raise HTTPException(status_code=404, detail="Vocal file not found or separation not completed.")
    vpath = job["stems"].get("vocals")
    if not vpath:
        raise HTTPException(status_code=404, detail="Vocals file not found.")
    abs_path = os.path.join(BASE_DIR, vpath.lstrip("/"))
    return FileResponse(abs_path, media_type="audio/mpeg" if has_ffmpeg else "audio/wav", filename=f"vocals_{job['filename']}")

# API: GET /download/instrumental/{job}
@app.get("/download/instrumental/{job_id}")
def download_instrumental(request: Request, job_id: str):
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Unauthorized")
        
    job = jobs.get(job_id)
    if not job or job.get("user_id") != user_id or job["status"] != "finished":
        raise HTTPException(status_code=404, detail="Instrumental file not found or separation not completed.")
    ipath = job["stems"].get("instrumental")
    if not ipath:
        raise HTTPException(status_code=404, detail="Instrumental file not found.")
    abs_path = os.path.join(BASE_DIR, ipath.lstrip("/"))
    return FileResponse(abs_path, media_type="audio/mpeg" if has_ffmpeg else "audio/wav", filename=f"instrumental_{job['filename']}")

# API: GET /download/all/{job} (ZIP)
@app.get("/download/all/{job_id}")
def download_all_zip(request: Request, job_id: str):
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Unauthorized")
        
    job = jobs.get(job_id)
    if not job or job.get("user_id") != user_id or job["status"] != "finished":
        raise HTTPException(status_code=404, detail="Job files not found or separation not completed.")
        
    job_out_dir = os.path.join(OUTPUT_DIR, job_id)
    zip_filename = f"separated_stems_{job_id}"
    zip_path = os.path.join(job_out_dir, f"{zip_filename}.zip")
    
    # Recreate ZIP if missing
    if not os.path.exists(zip_path):
        model_name = job.get("model", "htdemucs")
        if job.get("mode") == "6stems":
            model_name = "htdemucs_6s"
        stems_folder = os.path.join(job_out_dir, model_name, "original")
        if not os.path.exists(stems_folder):
            stems_folder = job_out_dir
        
        files_to_zip = []
        for root, _, files in os.walk(stems_folder):
            for file in files:
                if file.endswith((".mp3", ".wav")) and not file.startswith("separated_stems_"):
                    files_to_zip.append(os.path.join(root, file))
                    
        if not files_to_zip:
            raise HTTPException(status_code=404, detail="No stems files found to pack.")
            
        import zipfile
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for f in files_to_zip:
                arcname = os.path.basename(f)
                zipf.write(f, arcname)
                
    return FileResponse(zip_path, media_type="application/zip", filename=f"separated_stems_{job['filename']}.zip")

# API: GET /preview/{job} or GET /preview/{stem}/{job}
@app.get("/preview/{job_id}")
@app.get("/preview/{stem}/{job_id}")
def preview_audio(request: Request, job_id: str, stem: Optional[str] = None):
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Unauthorized")
        
    job = jobs.get(job_id)
    if not job or job.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="Job not found.")
        
    if not stem or stem == "original":
        abs_path = job["filepath"]
        ext = job["ext"]
    else:
        if job["status"] != "finished":
            raise HTTPException(status_code=400, detail="Separation stems not ready yet.")
        rel_path = job["stems"].get(stem)
        if not rel_path:
            raise HTTPException(status_code=404, detail=f"Stem '{stem}' not found.")
        abs_path = os.path.join(BASE_DIR, rel_path.lstrip("/"))
        ext = "mp3" if has_ffmpeg else "wav"
        
    if not os.path.exists(abs_path):
        raise HTTPException(status_code=404, detail="Audio file does not exist on disk.")
        
    media_types = {
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
        "flac": "audio/flac",
        "m4a": "audio/mp4",
        "ogg": "audio/ogg"
    }
    
    return FileResponse(abs_path, media_type=media_types.get(ext, "audio/mpeg"))

# API: GET /history
@app.get("/history")
def get_history(request: Request):
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Unauthorized")
        
    user_jobs = database.get_user_jobs(user_id)
    return user_jobs

# API: POST /history/clear
@app.post("/history/clear")
def clear_history(request: Request):
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Unauthorized")
        
    user_jobs = database.get_user_jobs(user_id)
    for job in user_jobs:
        job_id = job["job_id"]
        up_dir = os.path.join(UPLOAD_DIR, job_id)
        out_dir = os.path.join(OUTPUT_DIR, job_id)
        shutil.rmtree(up_dir, ignore_errors=True)
        shutil.rmtree(out_dir, ignore_errors=True)
        jobs.pop(job_id, None)
        
    database.clear_user_history(user_id)
    return {"status": "success", "message": "History cleared and files deleted."}

if __name__ == "__main__":
    import uvicorn
    # Start FastAPI server on port 8000
    uvicorn.run(app, host="127.0.0.1", port=8000)
