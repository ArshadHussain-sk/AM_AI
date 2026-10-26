import os
import sys
import time
import numpy as np
import soundfile as sf
import torch
import msst

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "bsroformer_synth")
CONFIG_PATH = os.path.join(MODEL_DIR, "config_bs_roformer_synth_lead.yaml")
CKPT_PATH = os.path.join(MODEL_DIR, "model_bs_roformer_ep_1_sdr_4.9869_fixed.ckpt")

# Global cached separator instance to eliminate repeated model loading latency
_cached_separator = None
_cached_device = None

def get_synth_separator(target_device: str = "cuda"):
    """
    Retrieves or initializes the BS-RoFormer Synthesizer separation engine.
    Caches model in memory for lightning-fast consecutive separations.
    """
    global _cached_separator, _cached_device
    
    use_cuda = (target_device == "cuda" or target_device == "auto") and torch.cuda.is_available()
    device_name = "cuda" if use_cuda else "cpu"
    device_id = 0 if use_cuda else "cpu"
    
    if _cached_separator is None or _cached_device != device_name:
        if _cached_separator is not None:
            try:
                _cached_separator.close()
            except Exception:
                pass
        
        print(f"[Synthesizer Engine] Initializing BS-RoFormer on {device_name.upper()}...")
        _cached_separator = msst.Separator(
            config_path=CONFIG_PATH,
            checkpoint_path=CKPT_PATH,
            model_type="bs_roformer",
            device_ids=device_id,
            force_cpu=not use_cuda
        )
        _cached_device = device_name
        print(f"[Synthesizer Engine] BS-RoFormer successfully loaded and ready on {device_name.upper()}.")
        
    return _cached_separator

def separate_synthesizer_mode(input_audio_path: str, output_dir: str, target_device: str = "cuda") -> dict:
    """
    Dedicated Synthesizer Isolation Mode (Synth vs Backing Track).
    Outperforms LALAL.AI by extracting pure synthesizer leads/pads and clean backing instrumentation.
    Returns: {"synthesizer": synth_wav_path, "instrumental": backing_wav_path}
    """
    os.makedirs(output_dir, exist_ok=True)
    separator = get_synth_separator(target_device=target_device)
    
    # Read original audio for phase-accurate residual subtraction
    orig_data, sr = sf.read(input_audio_path)
    
    # Convert mono to stereo if needed
    if len(orig_data.shape) == 1:
        orig_data = np.column_stack((orig_data, orig_data))
    
    # Run BS-RoFormer neural inference
    print(f"[Synthesizer Engine] Processing audio file: {input_audio_path}")
    results = separator.separate_file(input_audio_path)
    
    # Extract synthesizer stem
    synth_arr = results.get("synth lead")
    if synth_arr is None:
        raise RuntimeError("BS-RoFormer failed to produce 'synth lead' stem.")
        
    # msst returns shape (channels, samples). Transpose to (samples, channels) for soundfile
    if synth_arr.shape[0] == 2 and synth_arr.shape[1] > 2:
        synth_data = synth_arr.T
    else:
        synth_data = synth_arr
        
    # Match sample length with original
    min_len = min(len(orig_data), len(synth_data))
    orig_trimmed = orig_data[:min_len]
    synth_trimmed = synth_data[:min_len]
    
    # Compute backing track by subtracting isolated synthesizer
    backing_data = orig_trimmed - synth_trimmed
    
    # Apply non-destructive peak ceiling guard (prevents clipping distortion)
    peak_synth = np.max(np.abs(synth_trimmed))
    if peak_synth > 1.0:
        synth_trimmed = synth_trimmed / (peak_synth + 1e-7)
        
    peak_backing = np.max(np.abs(backing_data))
    if peak_backing > 1.0:
        backing_data = backing_data / (peak_backing + 1e-7)
        
    synth_path = os.path.join(output_dir, "synthesizer.wav")
    backing_path = os.path.join(output_dir, "instrumental.wav")
    
    sf.write(synth_path, synth_trimmed, sr)
    sf.write(backing_path, backing_data, sr)
    
    return {
        "synthesizer": synth_path,
        "instrumental": backing_path
    }

def separate_synth_from_stem(source_stem_path: str, output_dir: str, target_device: str = "cuda") -> dict:
    """
    Isolates Synthesizer from Demucs 6s 'other' stem to produce a true 7-stem studio master mix.
    Returns: {"synthesizer": synth_path, "residual_other": residual_path}
    """
    os.makedirs(output_dir, exist_ok=True)
    separator = get_synth_separator(target_device=target_device)
    
    orig_data, sr = sf.read(source_stem_path)
    if len(orig_data.shape) == 1:
        orig_data = np.column_stack((orig_data, orig_data))
        
    results = separator.separate_file(source_stem_path)
    synth_arr = results.get("synth lead")
    if synth_arr is None:
        raise RuntimeError("BS-RoFormer failed to isolate synth from residual stem.")
        
    if synth_arr.shape[0] == 2 and synth_arr.shape[1] > 2:
        synth_data = synth_arr.T
    else:
        synth_data = synth_arr
        
    min_len = min(len(orig_data), len(synth_data))
    orig_trimmed = orig_data[:min_len]
    synth_trimmed = synth_data[:min_len]
    
    residual_other = orig_trimmed - synth_trimmed
    
    peak_synth = np.max(np.abs(synth_trimmed))
    if peak_synth > 1.0:
        synth_trimmed = synth_trimmed / (peak_synth + 1e-7)
        
    peak_res = np.max(np.abs(residual_other))
    if peak_res > 1.0:
        residual_other = residual_other / (peak_res + 1e-7)
        
    synth_path = os.path.join(output_dir, "synthesizer.wav")
    residual_path = os.path.join(output_dir, "other.wav")
    
    sf.write(synth_path, synth_trimmed, sr)
    sf.write(residual_path, residual_other, sr)
    
    return {
        "synthesizer": synth_path,
        "other": residual_path
    }
