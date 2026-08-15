// AM AI Audio Separator - Client Side Logic

// State variables
let currentJobId = null;
let originalWavesurfer = null;
let wavesurferInstances = {};
let pollingInterval = null;
let currentPlayingInstance = null; // Track which audio player is currently playing

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

// 7. Results Renderer & Player setup
function displayResults(jobData) {
    showSection('results');

    const container = document.getElementById('results-stems-container');
    container.innerHTML = ''; // Clear existing
    
    // Destroy previous wavesurfer instances
    Object.values(wavesurferInstances).forEach(ws => {
        if (ws) ws.destroy();
    });
    wavesurferInstances = {};

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

        const card = document.createElement('div');
        card.className = 'stem-player-card';
        card.innerHTML = `
            <div class="stem-player-header">
                <div class="stem-title-wrapper">
                    <span class="stem-badge" style="background: ${cfg.progress}">${cfg.badge}</span>
                    <span class="stem-title">${jobData.filename} (${cfg.badge})</span>
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
                    <button class="btn-play-pause" id="btn-play-${stemName}" onclick="togglePlayStem('${stemName}')">
                        <svg class="play-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                        <svg class="pause-icon hidden" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                    </button>
                    <span class="time-display" id="time-${stemName}">00:00 / 00:00</span>
                    <div class="volume-control">
                        <svg class="volume-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                        </svg>
                        <input type="range" class="volume-slider" min="0" max="1" step="0.05" value="0.8" oninput="setStemVolume('${stemName}', this.value)">
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
            document.getElementById(`time-${stemName}`).textContent = `00:00 / ${formatTime(ws.getDuration())}`;
        });

        ws.on('audioprocess', () => {
            const current = formatTime(ws.getCurrentTime());
            const total = formatTime(ws.getDuration());
            document.getElementById(`time-${stemName}`).textContent = `${current} / ${total}`;
        });

        ws.on('finish', () => {
            const btn = document.getElementById(`btn-play-${stemName}`);
            btn.querySelector('.play-icon').classList.remove('hidden');
            btn.querySelector('.pause-icon').classList.add('hidden');
            const wContainer = document.getElementById(`waveform-${stemName}`);
            if (wContainer) wContainer.classList.remove('playing');
        });

        wavesurferInstances[stemName] = ws;
    });

    // Setup ZIP download URL
    document.getElementById('btn-download-all').setAttribute('onclick', `downloadAllStems('${jobData.job_id}')`);
}

function togglePlayStem(stemName) {
    const ws = wavesurferInstances[stemName];
    if (!ws) return;

    const btn = document.getElementById(`btn-play-${stemName}`);
    const container = document.getElementById(`waveform-${stemName}`);

    // If it's already playing, pause it
    if (ws.isPlaying()) {
        ws.pause();
        btn.querySelector('.play-icon').classList.remove('hidden');
        btn.querySelector('.pause-icon').classList.add('hidden');
        if (container) container.classList.remove('playing');
        currentPlayingInstance = null;
    } else {
        // Pause any other stem that might be playing currently to avoid sound overlapping
        pauseAllAudio();
        ws.play();
        btn.querySelector('.play-icon').classList.add('hidden');
        btn.querySelector('.pause-icon').classList.remove('hidden');
        if (container) container.classList.add('playing');
        currentPlayingInstance = ws;
    }
}

function setStemVolume(stemName, val) {
    const ws = wavesurferInstances[stemName];
    if (ws) {
        ws.setVolume(val);
    }
}

function pauseAllAudio() {
    // Pause original preview player
    if (originalWavesurfer && originalWavesurfer.isPlaying()) {
        originalWavesurfer.pause();
        const btnPlay = document.getElementById('btn-play-original');
        btnPlay.querySelector('.play-icon').classList.remove('hidden');
        btnPlay.querySelector('.pause-icon').classList.add('hidden');
    }
    const origWf = document.getElementById('original-waveform-preview');
    if (origWf) origWf.classList.remove('playing');

    // Pause all stem players
    Object.keys(wavesurferInstances).forEach(name => {
        const ws = wavesurferInstances[name];
        if (ws && ws.isPlaying()) {
            ws.pause();
            const btn = document.getElementById(`btn-play-${name}`);
            btn.querySelector('.play-icon').classList.remove('hidden');
            btn.querySelector('.pause-icon').classList.add('hidden');
        }
        const stemWf = document.getElementById(`waveform-${name}`);
        if (stemWf) stemWf.classList.remove('playing');
    });
    
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

// Keyboard shortcuts (Space to Play/Pause active player)
function setupGlobalShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Spacebar shortcut
        if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT' && e.target.tagName !== 'TEXTAREA') {
            e.preventDefault();
            
            // Play/Pause whatever is active
            if (currentPlayingInstance) {
                // Determine if it's original or stem
                if (originalWavesurfer && currentPlayingInstance === originalWavesurfer) {
                    togglePlayOriginal();
                } else {
                    // find matching stem name
                    const stemName = Object.keys(wavesurferInstances).find(k => wavesurferInstances[k] === currentPlayingInstance);
                    if (stemName) {
                        togglePlayStem(stemName);
                    }
                }
            } else {
                // If nothing playing, but we have original preview loaded, play it
                if (sections.preview.classList.contains('active') && originalWavesurfer) {
                    togglePlayOriginal();
                } else if (sections.results.classList.contains('active')) {
                    // Play first stem in results
                    const firstStem = Object.keys(wavesurferInstances)[0];
                    if (firstStem) {
                        togglePlayStem(firstStem);
                    }
                }
            }
        }
        
        // Escape shortcut for modals
        if (e.code === 'Escape') {
            closeAboutModal();
        }
    });
}

// Modal Controllers
function openAboutModal() {
    document.getElementById('about-modal').classList.add('open');
}

function closeAboutModal() {
    document.getElementById('about-modal').classList.remove('open');
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
