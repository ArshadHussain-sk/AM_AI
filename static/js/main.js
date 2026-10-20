// AM AI Audio Separator - Client Side Logic

// State variables
let currentJobId = null;
let originalWavesurfer = null;
let wavesurferInstances = {};
let pollingInterval = null;
let currentPlayingInstance = null; // Track which audio player is currently playing
let masterPlaying = false;
let stemStates = {}; // stemName: { muted: false, soloed: false, volume: 1.0 }
let isABComparing = false;
let currentTourSlide = 1;
let currentJobData = null;

// UI section mapping
const sections = {
    upload: document.getElementById('section-upload'),
    preview: document.getElementById('section-preview'),
    processing: document.getElementById('section-processing'),
    results: document.getElementById('section-results')
};

// Document Load Initializer
document.addEventListener('DOMContentLoaded', () => {
    setupDragAndDrop();
    loadHistoryList();
    setupGlobalShortcuts();
    checkFirstTimeUserTour();
});

// 1. Drag & Drop File Upload Handling
function setupDragAndDrop() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');

    if (!dropZone) return;

    // Prevent default drag behaviors
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false);
    });

    // Highlight drop zone on drag over
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
    });

    // Handle dropped files
    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length > 0) {
            handleFileUpload(files[0]);
        }
    });

    // Handle file input change
    fileInput.addEventListener('change', (e) => {
        if (fileInput.files.length > 0) {
            handleFileUpload(fileInput.files[0]);
        }
    });
}

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

// 2. Upload Audio File API call
async function handleFileUpload(file) {
    // Validate file size (500MB)
    const maxSize = 500 * 1024 * 1024;
    if (file.size > maxSize) {
        showToast('File is too large. Maximum allowed size is 500 MB.', 'error');
        return;
    }

    // Validate file extension
    const ext = file.name.split('.').pop().toLowerCase();
    const supported = ['mp3', 'wav', 'flac', 'm4a', 'ogg'];
    if (!supported.includes(ext)) {
        showToast('Unsupported format. Please upload MP3, WAV, FLAC, M4A, or OGG.', 'error');
        return;
    }

    // Start UI Transition: Show loading toast
    showToast('Uploading audio file...', 'info');
    
    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Upload failed');
        }

        const data = await response.json();
        currentJobId = data.job_id;
        
        showToast('Upload complete! Loading waveform...', 'success');
        setupAudioPreview(data);
        loadHistoryList(); // Refresh history panel
    } catch (err) {
        showToast(err.message, 'error');
        console.error(err);
    }
}

// 3. Audio Preview Waveform setup (Wavesurfer)
function setupAudioPreview(metadata) {
    // Transition to preview section
    showSection('preview');

    // Set metadata text
    document.getElementById('preview-filename').textContent = metadata.filename;
    document.getElementById('preview-duration').textContent = formatTime(metadata.duration);
    document.getElementById('preview-size').textContent = (metadata.size / (1024 * 1024)).toFixed(1) + ' MB';
    document.getElementById('preview-format').textContent = metadata.filename.split('.').pop().toUpperCase();

    // Destroy existing wavesurfer if active
    if (originalWavesurfer) {
        originalWavesurfer.destroy();
    }

    // Initialize wavesurfer for original audio preview
    originalWavesurfer = WaveSurfer.create({
        container: '#original-waveform-preview',
        waveColor: '#4f46e5',
        progressColor: '#c084fc',
        cursorColor: '#f43f5e',
        barWidth: 2,
        barGap: 3,
        barRadius: 2,
        height: 80,
        responsive: true
    });

    // Load preview audio stream (using static upload path to support seeking range headers)
    originalWavesurfer.load(metadata.original_url);

    // Update play button & time tracking
    originalWavesurfer.on('ready', () => {
        const durationText = formatTime(originalWavesurfer.getDuration());
        document.getElementById('time-original').textContent = `00:00 / ${durationText}`;
    });

    originalWavesurfer.on('audioprocess', () => {
        const current = formatTime(originalWavesurfer.getCurrentTime());
        const total = formatTime(originalWavesurfer.getDuration());
        document.getElementById('time-original').textContent = `${current} / ${total}`;
    });

    originalWavesurfer.on('finish', () => {
        const btnPlay = document.getElementById('btn-play-original');
        btnPlay.querySelector('.play-icon').classList.remove('hidden');
        btnPlay.querySelector('.pause-icon').classList.add('hidden');
        const container = document.getElementById('original-waveform-preview');
        if (container) container.classList.remove('playing');
    });

    // Volume Slider listener
    const volumeSlider = document.getElementById('original-volume');
    volumeSlider.addEventListener('input', (e) => {
        originalWavesurfer.setVolume(e.target.value);
    });
}

function togglePlayOriginal() {
    if (!originalWavesurfer) return;

    pauseAllAudio();

    const btnPlay = document.getElementById('btn-play-original');
    const container = document.getElementById('original-waveform-preview');
    if (originalWavesurfer.isPlaying()) {
        originalWavesurfer.pause();
        btnPlay.querySelector('.play-icon').classList.remove('hidden');
        btnPlay.querySelector('.pause-icon').classList.add('hidden');
        if (container) container.classList.remove('playing');
        currentPlayingInstance = null;
    } else {
        originalWavesurfer.play();
        btnPlay.querySelector('.play-icon').classList.add('hidden');
        btnPlay.querySelector('.pause-icon').classList.remove('hidden');
        if (container) container.classList.add('playing');
        currentPlayingInstance = originalWavesurfer;
    }
}

// 4. Radio Group Mode Toggle UI logic
function updateModeUI(mode) {
    const radioLabels = document.querySelectorAll('.radio-label');
    radioLabels.forEach(lbl => {
        const input = lbl.querySelector('input');
        if (input.value === mode) {
            lbl.classList.add('active');
            input.checked = true;
        } else {
            lbl.classList.remove('active');
        }
    });

    const modelSelect = document.getElementById('select-model');
    if (modelSelect) {
        if (mode === '6stems') {
            modelSelect.value = 'htdemucs_6s';
            // Disable other options to prevent user errors since 6-stems requires htdemucs_6s
            for (let opt of modelSelect.options) {
                if (opt.value !== 'htdemucs_6s') opt.disabled = true;
            }
        } else {
            // Enable other options
            for (let opt of modelSelect.options) {
                opt.disabled = false;
            }
            // If it was htdemucs_6s, switch it back to default htdemucs
            if (modelSelect.value === 'htdemucs_6s') {
                modelSelect.value = 'htdemucs';
            }
        }
        updateModelDescription();
    }
}

// 5. Trigger Demucs separation API call
async function startSeparation() {
    if (!currentJobId) return;

    const mode = document.querySelector('input[name="separate-mode"]:checked').value;
    const device = document.getElementById('select-device').value;

    // Transition to processing screen
    showSection('processing');
    
    // Stop playing preview audio if any
    if (originalWavesurfer && originalWavesurfer.isPlaying()) {
        originalWavesurfer.pause();
    }

    // Reset progress steps UI
    document.getElementById('step-upload').className = 'progress-step done';
    document.getElementById('step-queue').className = 'progress-step active';
    document.getElementById('step-model').className = 'progress-step';
    document.getElementById('step-separate').className = 'progress-step';

    document.getElementById('processing-progress-fill').style.width = '0%';
    document.getElementById('processing-progress-text').textContent = '0%';
    document.getElementById('processing-status-text').textContent = 'Submitting task to processing queue...';

    // Start dynamic AI Engine activity insight panel rotation
    startInsightRotation();

    try {
        const formData = new FormData();
        formData.append('mode', mode);
        formData.append('device', device);
        
        const modelSelect = document.getElementById('select-model');
        const selectedModel = modelSelect ? modelSelect.value : 'htdemucs';
        formData.append('model', selectedModel);

        const normalize = document.getElementById('check-normalize') ? document.getElementById('check-normalize').checked : true;
        const noiseGate = document.getElementById('check-noise-gate') ? document.getElementById('check-noise-gate').checked : false;
        formData.append('normalize', normalize);
        formData.append('noise_gate', noiseGate);

        const response = await fetch(`/separate/${currentJobId}`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Separation start failed');
        }

        // Start polling status
        pollingInterval = setInterval(pollJobStatus, 1500);
    } catch (err) {
        showToast(err.message, 'error');
        resetToUpload();
    }
}

// 6. Polling status API call
async function pollJobStatus() {
    if (!currentJobId) return;

    try {
        const response = await fetch(`/status/${currentJobId}`);
        if (!response.ok) throw new Error('Failed to fetch status');

        const data = await response.json();
        
        // Update progress bar
        const progress = data.progress;
        document.getElementById('processing-progress-fill').style.width = `${progress}%`;
        document.getElementById('processing-progress-text').textContent = `${progress}%`;

        // Update progress step list based on server status
        if (data.status === 'queued') {
            document.getElementById('step-queue').className = 'progress-step active';
            document.getElementById('processing-status-text').textContent = 'Waiting in server separation queue...';
            document.getElementById('processing-queue-warning').classList.remove('hidden');
        } else if (data.status === 'processing') {
            document.getElementById('processing-queue-warning').classList.add('hidden');
            document.getElementById('step-queue').className = 'progress-step done';
            
            if (progress < 15) {
                document.getElementById('step-model').className = 'progress-step active';
                document.getElementById('processing-status-text').textContent = 'Loading Meta Demucs transformer weights (could take up to 20 seconds)...';
            } else {
                document.getElementById('step-model').className = 'progress-step done';
                document.getElementById('step-separate').className = 'progress-step active';
                
                const remainingProgress = ((progress - 15) / 85 * 100).toFixed(0);
                document.getElementById('processing-status-text').textContent = `AI separation layer parsing: ${remainingProgress}%`;
            }
        } else if (data.status === 'finished') {
            clearInterval(pollingInterval);
            stopInsightRotation();
            document.getElementById('step-model').className = 'progress-step done';
            document.getElementById('step-separate').className = 'progress-step done';
            
            showToast('Audio separated successfully!', 'success');
            loadHistoryList(); // Refresh history panel
            displayResults(data);
        } else if (data.status === 'failed') {
            clearInterval(pollingInterval);
            stopInsightRotation();
            throw new Error(data.error || 'AI processing pipeline failed');
        }
    } catch (err) {
        clearInterval(pollingInterval);
        stopInsightRotation();
        showToast(err.message, 'error');
        console.error(err);
        resetToUpload();
    }
}

// 7. Results Renderer & Studio Mixer Engine
function displayResults(jobData) {
    showSection('results');
    currentJobData = jobData;

    const container = document.getElementById('results-stems-container');
    container.innerHTML = ''; // Clear existing
    
    // Destroy previous wavesurfer instances
    Object.values(wavesurferInstances).forEach(ws => {
        if (ws) ws.destroy();
    });
    wavesurferInstances = {};
    stemStates = {};
    masterPlaying = false;
    isABComparing = false;

    // Reset Master Transport Controls
    updateMasterPlayButton(false);
    const abBtn = document.getElementById('btn-ab-compare');
    if (abBtn) abBtn.classList.remove('active-original');
    const abLabel = document.getElementById('ab-label');
    if (abLabel) abLabel.textContent = 'Mode: Isolated Stems';
    const scrubber = document.getElementById('master-scrubber');
    if (scrubber) scrubber.value = 0;
    const masterTime = document.getElementById('master-time-display');
    if (masterTime) masterTime.textContent = '00:00 / 00:00';

    const stems = jobData.stems;
    const mode = jobData.mode;

    // Define color mappings for stem designs to make them look premium
    const colors = {
        vocals: { wave: '#6366f1', progress: '#d946ef', badge: 'Vocals' },
        instrumental: { wave: '#14b8a6', progress: '#22d3ee', badge: 'Instrumental' },
        drums: { wave: '#f59e0b', progress: '#fbbf24', badge: 'Drums' },
        bass: { wave: '#ef4444', progress: '#f87171', badge: 'Bass' },
        guitar: { wave: '#ec4899', progress: '#f43f5e', badge: 'Guitar' },
        piano: { wave: '#a855f7', progress: '#c084fc', badge: 'Piano' },
        other: { wave: '#10b981', progress: '#34d399', badge: 'Other Stems' }
    };

    // Filter available stems (non-null paths)
    const activeStems = Object.keys(stems).filter(key => stems[key] !== null);

    activeStems.forEach(stemName => {
        const audioUrl = stems[stemName];
        const cfg = colors[stemName] || { wave: '#818cf8', progress: '#c084fc', badge: stemName };

        // Initialize state for this stem
        stemStates[stemName] = {
            muted: false,
            soloed: false,
            volume: 1.0
        };

        const card = document.createElement('div');
        card.className = 'stem-player-card';
        card.id = `stem-card-${stemName}`;
        card.innerHTML = `
            <div class="stem-player-header">
                <div class="stem-title-wrapper">
                    <div class="eq-bars" id="eq-bars-${stemName}">
                        <span class="eq-bar"></span>
                        <span class="eq-bar"></span>
                        <span class="eq-bar"></span>
                        <span class="eq-bar"></span>
                    </div>
                    <span class="stem-badge" style="background: ${cfg.progress}">${cfg.badge}</span>
                    <span class="stem-title">${jobData.filename} (${cfg.badge})</span>
                </div>
                
                <!-- Solo and Mute DAW Controls -->
                <div class="stem-quick-controls">
                    <button class="btn-solo" id="btn-solo-${stemName}" onclick="toggleSolo('${stemName}')" title="Solo this track (S)">S</button>
                    <button class="btn-mute" id="btn-mute-${stemName}" onclick="toggleMute('${stemName}')" title="Mute this track (M)">M</button>
                </div>

                <div class="stem-player-actions">
                    <button class="btn-icon" onclick="copyDownloadLink('${stemName}', '${jobData.job_id}')" title="Copy Stream Link">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                    </button>
                    <button class="btn-icon" onclick="downloadStem('${stemName}', '${jobData.job_id}')" title="Download Audio File">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                    </button>
                </div>
            </div>
            <div class="waveform-container">
                <div id="waveform-${stemName}" class="wavesurfer-waveform"></div>
                <div class="waveform-controls">
                    <button class="btn-play-pause" id="btn-play-${stemName}" onclick="togglePlayStem('${stemName}')" title="Toggle individual stem preview">
                        <svg class="play-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                        <svg class="pause-icon hidden" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                    </button>
                    <span class="time-display" id="time-${stemName}">00:00 / 00:00</span>
                    <div class="volume-control">
                        <svg class="volume-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                        </svg>
                        <input type="range" class="volume-slider" id="vol-slider-${stemName}" min="0" max="1" step="0.05" value="1.0" oninput="setStemVolume('${stemName}', this.value)" title="Track Volume Fader">
                        <span class="vol-label" id="vol-label-${stemName}" style="font-size: 0.75rem; color: var(--text-muted); width: 34px;">100%</span>
                    </div>
                </div>
            </div>
        `;

        container.appendChild(card);

        // Initialize Wavesurfer instance
        const ws = WaveSurfer.create({
            container: `#waveform-${stemName}`,
            waveColor: cfg.wave,
            progressColor: cfg.progress,
            cursorColor: '#f43f5e',
            barWidth: 2,
            barGap: 3,
            barRadius: 2,
            height: 80,
            responsive: true
        });

        ws.load(audioUrl);

        ws.on('ready', () => {
            const dur = ws.getDuration();
            document.getElementById(`time-${stemName}`).textContent = `00:00 / ${formatTime(dur)}`;
            const masterTime = document.getElementById('master-time-display');
            if (masterTime && masterTime.textContent === '00:00 / 00:00') {
                masterTime.textContent = `00:00 / ${formatTime(dur)}`;
            }
        });

        ws.on('audioprocess', () => {
            const current = ws.getCurrentTime();
            const dur = ws.getDuration();
            document.getElementById(`time-${stemName}`).textContent = `${formatTime(current)} / ${formatTime(dur)}`;
            
            // Sync Master Scrubber & Time readout
            if (masterPlaying && dur > 0) {
                const pct = (current / dur) * 100;
                const scrubber = document.getElementById('master-scrubber');
                if (scrubber && !scrubber.matches(':active')) {
                    scrubber.value = pct;
                }
                const masterTime = document.getElementById('master-time-display');
                if (masterTime) {
                    masterTime.textContent = `${formatTime(current)} / ${formatTime(dur)}`;
                }
            }
        });

        ws.on('finish', () => {
            updateStemPlayButton(stemName, false);
            setStemEQDancing(stemName, false);
            
            // If all stems finished, pause master
            const anyPlaying = Object.values(wavesurferInstances).some(inst => inst && inst.isPlaying());
            if (!anyPlaying) {
                pauseMasterMix();
            }
        });

        // User clicked inside waveform to seek -> Sync all stems to that exact ratio!
        ws.on('interaction', (newProgress) => {
            seekAllStems(newProgress * 100);
        });

        wavesurferInstances[stemName] = ws;
    });

    // Setup ZIP download URL
    document.getElementById('btn-download-all').setAttribute('onclick', `downloadAllStems('${jobData.job_id}')`);
}

// ==========================================================================
// SYNCHRONIZED STUDIO MIXER CONTROLLERS
// ==========================================================================

function toggleMasterPlay() {
    if (isABComparing) {
        toggleABCompare(); // switch back to stems when hitting master play
    }
    if (masterPlaying) {
        pauseMasterMix();
    } else {
        playMasterMix();
    }
}

function playMasterMix() {
    masterPlaying = true;
    updateMasterPlayButton(true);

    const hasSolo = Object.values(stemStates).some(s => s.soloed);
    const masterVol = parseFloat(document.getElementById('master-volume-slider')?.value || 1.0);

    // Get reference playhead time
    const firstWs = Object.values(wavesurferInstances)[0];
    const refRatio = firstWs ? (firstWs.getCurrentTime() / (firstWs.getDuration() || 1)) : 0;

    Object.keys(wavesurferInstances).forEach(name => {
        const ws = wavesurferInstances[name];
        const state = stemStates[name];
        if (!ws || !state) return;

        // Ensure phase lock
        ws.seekTo(refRatio);

        const isAudible = hasSolo ? state.soloed : !state.muted;
        const targetVol = isAudible ? (state.volume * masterVol) : 0;
        ws.setVolume(targetVol);

        if (isAudible) {
            ws.play();
            updateStemPlayButton(name, true);
            setStemEQDancing(name, true);
        } else {
            ws.pause();
            updateStemPlayButton(name, false);
            setStemEQDancing(name, false);
        }
    });
}

function pauseMasterMix() {
    masterPlaying = false;
    updateMasterPlayButton(false);

    Object.keys(wavesurferInstances).forEach(name => {
        const ws = wavesurferInstances[name];
        if (ws && ws.isPlaying()) {
            ws.pause();
        }
        updateStemPlayButton(name, false);
        setStemEQDancing(name, false);
    });

    if (originalWavesurfer && originalWavesurfer.isPlaying()) {
        originalWavesurfer.pause();
    }
}

function updateMasterPlayButton(isPlaying) {
    const btn = document.getElementById('btn-master-play');
    const label = document.getElementById('master-play-label');
    if (!btn) return;

    if (isPlaying) {
        btn.querySelector('.play-icon')?.classList.add('hidden');
        btn.querySelector('.pause-icon')?.classList.remove('hidden');
        if (label) label.textContent = 'Pause Mix';
    } else {
        btn.querySelector('.play-icon')?.classList.remove('hidden');
        btn.querySelector('.pause-icon')?.classList.add('hidden');
        if (label) label.textContent = 'Play Mix';
    }
}

function seekAllStems(pct) {
    const ratio = Math.max(0, Math.min(1, parseFloat(pct) / 100));
    Object.values(wavesurferInstances).forEach(ws => {
        if (ws) ws.seekTo(ratio);
    });
    if (originalWavesurfer) {
        originalWavesurfer.seekTo(ratio);
    }

    const first = Object.values(wavesurferInstances)[0];
    if (first && first.getDuration() > 0) {
        const cur = first.getDuration() * ratio;
        const dur = first.getDuration();
        const readout = document.getElementById('master-time-display');
        if (readout) readout.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
    }
}

function toggleSolo(stemName) {
    const state = stemStates[stemName];
    if (!state) return;

    const wasSoloed = state.soloed;

    // Reset all solo indicators
    Object.keys(stemStates).forEach(name => {
        stemStates[name].soloed = false;
        const btn = document.getElementById(`btn-solo-${name}`);
        if (btn) btn.classList.remove('active');
    });

    if (!wasSoloed) {
        state.soloed = true;
        const btn = document.getElementById(`btn-solo-${stemName}`);
        if (btn) btn.classList.add('active');
        showToast(`Solo Active: ${stemName.toUpperCase()}`, 'info');
    } else {
        showToast('Solo cleared', 'info');
    }

    applyStemVolumes();
}

function toggleMute(stemName) {
    const state = stemStates[stemName];
    if (!state) return;

    state.muted = !state.muted;
    const btn = document.getElementById(`btn-mute-${stemName}`);
    if (btn) {
        btn.classList.toggle('active', state.muted);
    }
    showToast(`${stemName.toUpperCase()} ${state.muted ? 'Muted' : 'Unmuted'}`, 'info');
    applyStemVolumes();
}

function applyStemVolumes() {
    const hasSolo = Object.values(stemStates).some(s => s.soloed);
    const masterVol = parseFloat(document.getElementById('master-volume-slider')?.value || 1.0);

    Object.keys(wavesurferInstances).forEach(name => {
        const ws = wavesurferInstances[name];
        const state = stemStates[name];
        if (!ws || !state) return;

        let targetVol = 0;
        if (hasSolo) {
            targetVol = state.soloed ? (state.volume * masterVol) : 0;
        } else {
            targetVol = state.muted ? 0 : (state.volume * masterVol);
        }

        ws.setVolume(targetVol);
        const isAudible = targetVol > 0;
        
        if (masterPlaying) {
            if (isAudible) {
                if (!ws.isPlaying()) ws.play();
                updateStemPlayButton(name, true);
                setStemEQDancing(name, true);
            } else {
                if (ws.isPlaying()) ws.pause();
                updateStemPlayButton(name, false);
                setStemEQDancing(name, false);
            }
        }
    });
}

function setStemVolume(stemName, val) {
    const state = stemStates[stemName];
    if (state) {
        state.volume = parseFloat(val);
    }
    const label = document.getElementById(`vol-label-${stemName}`);
    if (label) {
        label.textContent = `${Math.round(parseFloat(val) * 100)}%`;
    }
    applyStemVolumes();
}

function setMasterVolume(val) {
    applyStemVolumes();
}

function toggleABCompare() {
    isABComparing = !isABComparing;
    const btn = document.getElementById('btn-ab-compare');
    const label = document.getElementById('ab-label');

    if (isABComparing) {
        if (btn) btn.classList.add('active-original');
        if (label) label.textContent = 'Mode: Raw Original';

        // Silence all stems
        Object.values(wavesurferInstances).forEach(ws => ws.setVolume(0));

        // Sync and play original
        if (originalWavesurfer) {
            const first = Object.values(wavesurferInstances)[0];
            if (first && first.getDuration() > 0) {
                originalWavesurfer.seekTo(first.getCurrentTime() / first.getDuration());
            }
            originalWavesurfer.setVolume(1.0);
            if (masterPlaying) {
                originalWavesurfer.play();
            }
        }
        showToast('A/B Test: Listening to Raw Original Upload', 'warning');
    } else {
        if (btn) btn.classList.remove('active-original');
        if (label) label.textContent = 'Mode: Isolated Stems';

        if (originalWavesurfer && originalWavesurfer.isPlaying()) {
            originalWavesurfer.pause();
        }
        applyStemVolumes();
        showToast('A/B Test: Listening to Isolated Stems Mix', 'success');
    }
}

function changePlaybackRate(val) {
    const rate = parseFloat(val);
    Object.values(wavesurferInstances).forEach(ws => {
        if (ws && typeof ws.setPlaybackRate === 'function') {
            ws.setPlaybackRate(rate);
        }
    });
    if (originalWavesurfer && typeof originalWavesurfer.setPlaybackRate === 'function') {
        originalWavesurfer.setPlaybackRate(rate);
    }
    showToast(`Playback speed: ${val}x`, 'info');
}

function resetStudioMixer() {
    Object.keys(stemStates).forEach(name => {
        stemStates[name].muted = false;
        stemStates[name].soloed = false;
        stemStates[name].volume = 1.0;
        const soloBtn = document.getElementById(`btn-solo-${name}`);
        if (soloBtn) soloBtn.classList.remove('active');
        const muteBtn = document.getElementById(`btn-mute-${name}`);
        if (muteBtn) muteBtn.classList.remove('active');
        const slider = document.getElementById(`vol-slider-${name}`);
        if (slider) slider.value = 1.0;
        const label = document.getElementById(`vol-label-${name}`);
        if (label) label.textContent = '100%';
    });

    const masterVol = document.getElementById('master-volume-slider');
    if (masterVol) masterVol.value = 1.0;

    const rateSelect = document.getElementById('select-playback-rate');
    if (rateSelect) {
        rateSelect.value = '1.0';
        changePlaybackRate(1.0);
    }

    if (isABComparing) {
        toggleABCompare();
    } else {
        applyStemVolumes();
    }
    showToast('Studio mixer faders reset to default', 'info');
}

function updateStemPlayButton(stemName, isPlaying) {
    const btn = document.getElementById(`btn-play-${stemName}`);
    if (!btn) return;
    if (isPlaying) {
        btn.querySelector('.play-icon')?.classList.add('hidden');
        btn.querySelector('.pause-icon')?.classList.remove('hidden');
    } else {
        btn.querySelector('.play-icon')?.classList.remove('hidden');
        btn.querySelector('.pause-icon')?.classList.add('hidden');
    }
}

function setStemEQDancing(stemName, isDancing) {
    const eq = document.getElementById(`eq-bars-${stemName}`);
    const card = document.getElementById(`stem-card-${stemName}`);
    if (eq) eq.classList.toggle('dancing', isDancing);
    if (card) card.classList.toggle('playing', isDancing);
}

function togglePlayStem(stemName) {
    const ws = wavesurferInstances[stemName];
    if (!ws) return;

    // 1. If this exact stem is already playing, simply pause it
    if (ws.isPlaying()) {
        ws.pause();
        updateStemPlayButton(stemName, false);
        setStemEQDancing(stemName, false);
        currentPlayingInstance = null;
        return;
    }

    // 2. PAUSE ALL OTHER PLAYERS ON THE ENTIRE PAGE IMMEDIATELY
    // Only the single selected stem will play!
    pauseAllAudio();

    // 3. Mark master mix as not playing
    masterPlaying = false;
    updateMasterPlayButton(false);

    // 4. Restore volume for this single stem from its volume slider
    const volSlider = document.getElementById(`vol-slider-${stemName}`);
    const targetVol = volSlider ? parseFloat(volSlider.value) : 1.0;
    ws.setVolume(targetVol);

    // 5. Play ONLY this individual stem
    ws.play();
    updateStemPlayButton(stemName, true);
    setStemEQDancing(stemName, true);
    currentPlayingInstance = ws;
}

function pauseAllAudio() {
    masterPlaying = false;
    updateMasterPlayButton(false);

    // Pause all stem wavesurfers completely
    Object.keys(wavesurferInstances).forEach(name => {
        const ws = wavesurferInstances[name];
        if (ws) {
            ws.pause();
        }
        updateStemPlayButton(name, false);
        setStemEQDancing(name, false);
    });

    // Pause original preview player if active
    if (originalWavesurfer && originalWavesurfer.isPlaying()) {
        originalWavesurfer.pause();
        const btnPlay = document.getElementById('btn-play-original');
        if (btnPlay) {
            btnPlay.querySelector('.play-icon')?.classList.remove('hidden');
            btnPlay.querySelector('.pause-icon')?.classList.add('hidden');
        }
        const origWf = document.getElementById('original-waveform-preview');
        if (origWf) origWf.classList.remove('playing');
    }

    currentPlayingInstance = null;
}

// 8. Copy download / stream link to clipboard
function copyDownloadLink(stemName, jobId) {
    const host = window.location.origin;
    // We can generate download URL structure
    let path = `/download/vocals/${jobId}`;
    if (stemName === 'instrumental') {
        path = `/download/instrumental/${jobId}`;
    } else if (['drums', 'bass', 'other', 'guitar', 'piano'].includes(stemName)) {
        // Fall back to direct outputs access static files
        const ws = wavesurferInstances[stemName];
        if (ws) {
            path = ws.getSrc();
        }
    }
    const fullUrl = host + path;

    navigator.clipboard.writeText(fullUrl).then(() => {
        showToast(`Copied ${stemName} shareable link to clipboard!`, 'success');
    }).catch(err => {
        showToast('Failed to copy link.', 'error');
    });
}

function downloadStem(stemName, jobId) {
    if (stemName === 'vocals') {
        window.open(`/download/vocals/${jobId}`, '_blank');
    } else if (stemName === 'instrumental') {
        window.open(`/download/instrumental/${jobId}`, '_blank');
    } else {
        // For sub-stems in 4 stems, download directly from preview URL (static mounted)
        const ws = wavesurferInstances[stemName];
        if (ws) {
            const url = ws.getSrc();
            const a = document.createElement('a');
            a.href = url;
            a.download = `${stemName}_output.mp3`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    }
}

function downloadAllStems(jobId) {
    window.open(`/download/all/${jobId}`, '_blank');
}

// 9. Job History panel UI loaders
async function loadHistoryList() {
    const container = document.getElementById('history-items-container');
    if (!container) return;

    try {
        const response = await fetch('/history');
        if (!response.ok) throw new Error('Failed to load history');

        const history = await response.json();
        if (history.length === 0) {
            container.innerHTML = '<div class="no-history">No recent operations. Drag a file above to begin!</div>';
            return;
        }

        container.innerHTML = '';
        history.forEach(item => {
            const date = new Date(item.created_at * 1000).toLocaleString([], {
                month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit'
            });
            const size = (item.size / (1024 * 1024)).toFixed(1) + ' MB';
            const duration = formatTime(item.duration);

            const div = document.createElement('div');
            div.className = 'history-item';
            div.innerHTML = `
                <div class="history-item-name" title="${item.filename}">${item.filename}</div>
                <div class="history-item-meta">${size} | ${duration}</div>
                <div class="history-item-status">
                    <span class="history-status-badge status-val-${item.status}">${item.status}</span>
                </div>
                <div class="history-item-action">
                    <button class="btn-history-load" onclick="loadJobFromHistory('${item.job_id}')">Load</button>
                </div>
            `;
            container.appendChild(div);
        });
    } catch (err) {
        console.error('Error loading history:', err);
    }
}

async function loadJobFromHistory(jobId) {
    try {
        const response = await fetch(`/status/${jobId}`);
        if (!response.ok) throw new Error('Job not found.');

        const data = await response.json();
        currentJobId = jobId;

        if (data.status === 'finished') {
            displayResults(data);
        } else if (data.status === 'queued' || data.status === 'processing') {
            // Re-bind insight rotation & show spinner
            showSection('processing');
            startInsightRotation();
            
            // Re-trigger polling
            pollingInterval = setInterval(pollJobStatus, 1500);
            showToast('Resuming active processing tracking...', 'info');
        } else {
            // failed
            showToast(`Separation failed: ${data.error || 'Unknown Error'}`, 'error');
            setupAudioPreview({
                job_id: data.job_id,
                filename: data.filename,
                duration: data.duration,
                size: data.size
            });
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function clearHistory() {
    if (!confirm('Are you sure you want to clear your local separation history? All audio files on the server will be deleted permanently.')) {
        return;
    }

    try {
        const response = await fetch('/history/clear', { method: 'POST' });
        if (!response.ok) throw new Error('Clear history failed');
        
        showToast('History cleared successfully.', 'success');
        resetToUpload();
        loadHistoryList();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// Helper: Transitions between UI tabs/sections
function showSection(sectionKey) {
    Object.keys(sections).forEach(key => {
        const el = sections[key];
        if (key === sectionKey) {
            el.style.display = 'block';
            setTimeout(() => el.classList.add('active'), 50);
        } else {
            el.classList.remove('active');
            el.style.display = 'none';
        }
    });
}

function resetToUpload() {
    // Stop playing audio
    pauseAllAudio();

    // Destroy active Wavesurfer instances
    if (originalWavesurfer) {
        originalWavesurfer.destroy();
        originalWavesurfer = null;
    }
    Object.values(wavesurferInstances).forEach(ws => {
        if (ws) ws.destroy();
    });
    wavesurferInstances = {};

    // Clear polling intervals
    clearInterval(pollingInterval);
    stopInsightRotation();

    currentJobId = null;
    showSection('upload');
}

// Helper: Time conversions
function formatTime(seconds) {
    if (isNaN(seconds) || seconds === null) return '00:00';
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

// Dynamic AI Insight Rotation Engine
let insightInterval = null;
const insights = [
    "Analyzing track frequencies and transients...",
    "Loading neural transformer layers into GPU memory...",
    "Executing Hybrid Attention calculations...",
    "Extracting vocal harmonics and formant filters...",
    "Demixing isolated music stems...",
    "Running Adaptive Noise Gates to clean background bleed...",
    "Applying Smart Normalization to maximize dynamic range...",
    "Transcoding output tracks to high-fidelity 320kbps MP3..."
];

function startInsightRotation() {
    stopInsightRotation();
    const insightEl = document.getElementById('processing-insight');
    if (!insightEl) return;
    
    let idx = 0;
    insightEl.textContent = insights[idx];
    insightEl.style.opacity = 1;
    
    insightInterval = setInterval(() => {
        idx = (idx + 1) % insights.length;
        insightEl.style.opacity = 0;
        setTimeout(() => {
            insightEl.textContent = insights[idx];
            insightEl.style.opacity = 1;
        }, 300);
    }, 4500);
}

function stopInsightRotation() {
    if (insightInterval) {
        clearInterval(insightInterval);
        insightInterval = null;
    }
}

// Toast Popups
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <div class="toast-content">${message}</div>
        <button class="toast-close" onclick="this.parentElement.remove()">&times;</button>
    `;

    container.appendChild(toast);

    // Auto remove after 4.5 seconds
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100px)';
        setTimeout(() => toast.remove(), 300);
    }, 4500);
}

// ==========================================================================
// SHORTCUTS, MODALS, AND FIRST-TIME ONBOARDING TOUR
// ==========================================================================

// Check if first-time user and trigger onboarding
function checkFirstTimeUserTour() {
    if (localStorage.getItem('am_ai_onboarding_completed') !== 'true') {
        setTimeout(() => {
            openOnboardingTour();
        }, 600);
    }
}

// Onboarding Tour Controllers
function openOnboardingTour() {
    currentTourSlide = 1;
    goToTourSlide(1);
    document.getElementById('onboarding-modal')?.classList.add('open');
}

function closeOnboardingTour() {
    const check = document.getElementById('check-tour-dont-show');
    if (check && check.checked) {
        localStorage.setItem('am_ai_onboarding_completed', 'true');
    }
    document.getElementById('onboarding-modal')?.classList.remove('open');
}

function goToTourSlide(idx) {
    currentTourSlide = idx;
    const slides = document.querySelectorAll('.tour-slide');
    const dots = document.querySelectorAll('.tour-dot');
    const title = document.getElementById('tour-step-title');
    const prevBtn = document.getElementById('btn-tour-prev');
    const nextBtn = document.getElementById('btn-tour-next');

    const titles = [
        "Welcome to AM AI Studio",
        "Precision AI Models",
        "Live Synchronized Mixer",
        "Hardware Power & Lossless Audio"
    ];

    slides.forEach((s, i) => s.classList.toggle('active', i === (idx - 1)));
    dots.forEach((d, i) => d.classList.toggle('active', i === (idx - 1)));

    if (title) title.textContent = titles[idx - 1] || "Studio Guide";
    if (prevBtn) prevBtn.style.display = idx > 1 ? 'inline-block' : 'none';
    if (nextBtn) nextBtn.textContent = idx === slides.length ? 'Launch Studio 🚀' : 'Next Step';
}

function nextTourSlide() {
    const total = document.querySelectorAll('.tour-slide').length || 4;
    if (currentTourSlide < total) {
        goToTourSlide(currentTourSlide + 1);
    } else {
        localStorage.setItem('am_ai_onboarding_completed', 'true');
        closeOnboardingTour();
        showToast('Ready to create! Drag and drop any track to start.', 'success');
    }
}

function prevTourSlide() {
    if (currentTourSlide > 1) {
        goToTourSlide(currentTourSlide - 1);
    }
}

// Telemetry & Hardware Modal
async function openTelemetryModal() {
    try {
        const res = await fetch('/api/system/telemetry');
        if (res.ok) {
            const data = await res.json();
            // Optional live update if needed
        }
    } catch (e) {
        console.log(e);
    }
    document.getElementById('telemetry-modal')?.classList.add('open');
}

function closeTelemetryModal() {
    document.getElementById('telemetry-modal')?.classList.remove('open');
}

// Shortcuts Modal
function openShortcutsModal() {
    document.getElementById('shortcuts-modal')?.classList.add('open');
}

function closeShortcutsModal() {
    document.getElementById('shortcuts-modal')?.classList.remove('open');
}

// Global Keyboard shortcuts
function setupGlobalShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Do not intercept keystrokes in form inputs
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
            return;
        }

        // Spacebar: Play / Pause active stem or Master Mix
        if (e.code === 'Space') {
            e.preventDefault();
            if (sections.results.classList.contains('active')) {
                // If an individual stem is currently playing, pause/resume it directly
                if (currentPlayingInstance) {
                    const activeStem = Object.keys(wavesurferInstances).find(k => wavesurferInstances[k] === currentPlayingInstance);
                    if (activeStem) {
                        togglePlayStem(activeStem);
                        return;
                    }
                }
                toggleMasterPlay();
            } else if (sections.preview.classList.contains('active') && originalWavesurfer) {
                togglePlayOriginal();
            }
        }

        // S: Solo active stem or first stem
        if (e.key === 's' || e.key === 'S') {
            if (sections.results.classList.contains('active')) {
                const first = Object.keys(wavesurferInstances)[0];
                if (first) toggleSolo(first);
            }
        }

        // M: Mute active stem or first stem
        if (e.key === 'm' || e.key === 'M') {
            if (sections.results.classList.contains('active')) {
                const first = Object.keys(wavesurferInstances)[0];
                if (first) toggleMute(first);
            }
        }

        // Left Arrow: Skip back 5 seconds
        if (e.code === 'ArrowLeft') {
            e.preventDefault();
            const first = Object.values(wavesurferInstances)[0];
            if (first && first.getDuration() > 0) {
                const newTime = Math.max(0, first.getCurrentTime() - 5);
                seekAllStems((newTime / first.getDuration()) * 100);
            }
        }

        // Right Arrow: Skip forward 5 seconds
        if (e.code === 'ArrowRight') {
            e.preventDefault();
            const first = Object.values(wavesurferInstances)[0];
            if (first && first.getDuration() > 0) {
                const newTime = Math.min(first.getDuration(), first.getCurrentTime() + 5);
                seekAllStems((newTime / first.getDuration()) * 100);
            }
        }

        // Question mark: Open shortcuts
        if (e.key === '?') {
            openShortcutsModal();
        }

        // Escape: Close any open modal
        if (e.code === 'Escape') {
            closeAboutModal();
            closeOnboardingTour();
            closeTelemetryModal();
            closeShortcutsModal();
        }
    });
}

// Modal Controllers
function openAboutModal() {
    document.getElementById('about-modal')?.classList.add('open');
}

function closeAboutModal() {
    document.getElementById('about-modal')?.classList.remove('open');
}

// 10. Update Model Descriptions Helper
function updateModelDescription() {
    const modelSelect = document.getElementById('select-model');
    const helpText = document.getElementById('model-help-text');
    if (!modelSelect || !helpText) return;
    
    const descriptions = {
        'htdemucs': 'Standard Hybrid Transformer Demucs. Fast, stable, and balanced.',
        'htdemucs_ft': '🎧 <strong>Recommended for Headphones (Fine-Tuned)</strong>: Maximum clarity, minimum noise, and transient preservation. Highly recommended for premium listening.',
        'mdx_extra': '🎧 <strong>Recommended (MDX-Net Extra)</strong>: Excellent vocal and instrumental separation, optimized to prevent bleeding between tracks.',
        'htdemucs_6s': '6-Stem Separation Engine: Isolates Guitar and Piano in addition to vocals, drums, bass, and other.'
    };
    helpText.innerHTML = descriptions[modelSelect.value] || 'Standard Separation Model.';
}
