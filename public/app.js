// Mathesis Teacher front end. Plain JavaScript, no build step.

const $ = (sel) => document.querySelector(sel);
const state = {
  folder: '', // '' = all, 'none' = unfiled, otherwise folder id
  level: '',
  topic: '',
  q: '',
  sort: 'newest',
  folders: [],
  levels: [],
  topics: [],
  videos: [],
  editing: null,
  editingFolder: null,
};

// ---------- api ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    // Session ran out (or password changed elsewhere): back to the login screen.
    showAuth({ needsSetup: false, canSetup: false });
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- rendering ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function formatSize(bytes) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function folderName(id) {
  return state.folders.find((f) => f.id === id)?.name || '';
}

function renderSidebar(unfiled) {
  const total = state.folders.reduce((n, f) => n + f.count, 0) + unfiled;
  const items = [
    { id: '', name: 'All videos', count: total },
    ...state.folders,
    { id: 'none', name: 'Unfiled', count: unfiled },
  ];
  $('#folderList').innerHTML = items
    .map((f) => {
      const editable = f.id && f.id !== 'none';
      return `<li data-folder="${f.id}" class="${state.folder === f.id ? 'active' : ''}">
        <span>${escapeHtml(f.name)}</span>
        <span>${editable ? `<button class="edit" data-edit-folder="${f.id}" title="Rename or delete" aria-label="Edit folder">✎</button>` : ''}<span class="count">${f.count}</span></span>
      </li>`;
    })
    .join('');

  $('#levelList').innerHTML = state.levels
    .map((l) => `<li data-level="${escapeHtml(l.name)}" class="${state.level === l.name ? 'active' : ''}">
        <span>${escapeHtml(l.name)}</span><span class="count">${l.count}</span></li>`)
    .join('');

  $('#topicList').innerHTML = state.topics.length
    ? state.topics
        .map((t) => `<button class="chip ${state.topic.toLowerCase() === t.name.toLowerCase() ? 'active' : ''}" data-topic="${escapeHtml(t.name)}">${escapeHtml(t.name)} <span class="muted">${t.count}</span></button>`)
        .join('')
    : '<p class="muted small">Topics appear here once you tag videos.</p>';

  $('#topicSuggestions').innerHTML = state.topics.map((t) => `<option value="${escapeHtml(t.name)}">`).join('');

  const folderOptions = ['<option value="">Unfiled</option>', ...state.folders.map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`)].join('');
  const levelOptions = ['<option value="">Not set</option>', ...state.levels.map((l) => `<option>${escapeHtml(l.name)}</option>`)].join('');
  for (const sel of ['#upFolder', '#edFolder']) {
    const keep = $(sel).value;
    $(sel).innerHTML = folderOptions;
    $(sel).value = keep;
  }
  for (const sel of ['#upLevel', '#edLevel']) {
    const keep = $(sel).value;
    $(sel).innerHTML = levelOptions;
    $(sel).value = keep;
  }
}

function renderGrid() {
  const filters = [];
  if (state.folder) filters.push(state.folder === 'none' ? 'Unfiled' : `folder “${folderName(state.folder)}”`);
  if (state.level) filters.push(state.level);
  if (state.topic) filters.push(`topic “${state.topic}”`);
  if (state.q) filters.push(`search “${state.q}”`);
  $('#filterNote').hidden = !filters.length;
  $('#filterNote').innerHTML = filters.length
    ? `${state.videos.length} video${state.videos.length === 1 ? '' : 's'} in ${escapeHtml(filters.join(', '))} · <button data-action="clear">Clear filters</button>`
    : '';

  $('#empty').hidden = state.videos.length > 0;
  $('#empty p').textContent = filters.length ? 'No videos match these filters.' : 'No videos here yet.';
  $('#empty button').hidden = filters.length > 0;

  $('#grid').innerHTML = state.videos
    .map((v) => `<button class="card" data-video="${v.id}">
        <div class="thumb">
          ${v.source === 'youtube'
            ? `<img src="${escapeHtml(v.thumbnailUrl)}" alt="" loading="lazy"><span class="badge yt-badge">YouTube</span>`
            : `<video src="${v.url}#t=1" preload="metadata" muted></video>`}
          ${v.durationSec ? `<span class="badge">${formatDuration(v.durationSec)}</span>` : ''}
          ${v.published ? '' : '<span class="badge hidden-badge">Hidden</span>'}
        </div>
        <div class="card-body">
          <p class="card-title">${escapeHtml(v.title)}</p>
          <p class="card-meta">${[v.level, folderName(v.folderId), new Date(v.createdAt).toLocaleDateString()].filter(Boolean).map(escapeHtml).join(' · ')}</p>
          <div class="chips">${v.topics.map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('')}</div>
        </div>
      </button>`)
    .join('');
}

async function refresh() {
  const params = new URLSearchParams({ sort: state.sort });
  if (state.folder) params.set('folder', state.folder);
  if (state.level) params.set('level', state.level);
  if (state.topic) params.set('topic', state.topic);
  if (state.q) params.set('q', state.q);
  const [folders, levels, topics, videos] = await Promise.all([
    api('/api/folders'),
    api('/api/levels'),
    api('/api/topics'),
    api(`/api/videos?${params}`),
  ]);
  state.folders = folders.folders;
  state.levels = levels.levels;
  state.topics = topics.topics;
  state.videos = videos.videos;
  // A filter can point at something that no longer exists (e.g. a deleted folder).
  if (state.folder && state.folder !== 'none' && !state.folders.some((f) => f.id === state.folder)) {
    state.folder = '';
    return refresh();
  }
  renderSidebar(folders.unfiled);
  renderGrid();
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2500);
}

function showError(sel, err) {
  $(sel).textContent = err ? err.message || String(err) : '';
  $(sel).hidden = !err;
}

// ---------- tag input ----------

const tagInputs = {};

function setupTagInput(key) {
  const box = document.querySelector(`.tag-input[data-for="${key}"]`);
  const input = box.querySelector('input');
  const tags = [];
  const render = () => {
    box.querySelectorAll('.tag').forEach((el) => el.remove());
    tags.forEach((t, i) => {
      const el = document.createElement('span');
      el.className = 'tag';
      el.innerHTML = `${escapeHtml(t)}<button type="button" aria-label="Remove ${escapeHtml(t)}">×</button>`;
      el.querySelector('button').onclick = () => {
        tags.splice(i, 1);
        render();
      };
      box.insertBefore(el, input);
    });
  };
  const add = (raw) => {
    for (const part of raw.split(',')) {
      const t = part.trim();
      if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
    }
    input.value = '';
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(input.value);
    } else if (e.key === 'Backspace' && !input.value && tags.length) {
      tags.pop();
      render();
    }
  });
  input.addEventListener('change', () => input.value.trim() && add(input.value));
  box.addEventListener('click', (e) => e.target === box && input.focus());
  tagInputs[key] = {
    get: () => {
      if (input.value.trim()) add(input.value); // keep whatever was typed but not confirmed
      return [...tags];
    },
    set: (list) => {
      tags.splice(0, tags.length, ...list);
      input.value = '';
      render();
    },
  };
}

// ---------- upload ----------

let chosenFile = null;

function readDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    const url = URL.createObjectURL(file);
    const done = (d) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(d) ? d : null);
    };
    v.onloadedmetadata = () => done(v.duration);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 5000);
    v.src = url;
  });
}

function chooseFile(file) {
  if (!file) return;
  chosenFile = file;
  $('#dropText').innerHTML = `<strong>${escapeHtml(file.name)}</strong><br><small class="muted">${formatSize(file.size)} · click to change</small>`;
  // Turn "02_linear-equations.mp4" into "02 linear equations" as a starting title.
  autoTitle(file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim());
}

let uploadMode = 'youtube';
let titleAuto = false; // true while the title is one we filled in, so a new link may replace it

function autoTitle(title) {
  if ($('#upTitle').value && !titleAuto) return; // never overwrite what the teacher typed
  $('#upTitle').value = title;
  titleAuto = true;
}
let ytLookup = 0;

function setUploadMode(mode) {
  uploadMode = mode;
  document.querySelectorAll('.segmented [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#ytPane').hidden = mode !== 'youtube';
  $('#drop').hidden = mode !== 'file';
  $('#upSubmit').textContent = mode === 'youtube' ? 'Add video' : 'Upload';
  showError('#upError', null);
}

// When a link is pasted, show its thumbnail and fill in the YouTube title.
async function lookUpYouTube() {
  const link = $('#ytUrl').value.trim();
  const ticket = ++ytLookup;
  if (!link) { $('#ytPreview').hidden = true; return; }
  try {
    const info = await api(`/api/youtube/info?url=${encodeURIComponent(link)}`);
    if (ticket !== ytLookup) return;
    $('#ytPreview').hidden = false;
    $('#ytThumb').src = `https://i.ytimg.com/vi/${encodeURIComponent(info.id)}/hqdefault.jpg`;
    if (info.found === false) {
      $('#ytFound').innerHTML = '<span class="error">YouTube can\'t find this video. If it is Private, change it to Unlisted.</span>';
    } else if (info.found) {
      $('#ytFound').textContent = `Found: “${info.title}”`;
      autoTitle(info.title);
    } else {
      $('#ytFound').textContent = 'Link looks right. (Could not reach YouTube to check the title.)';
    }
    showError('#upError', null);
  } catch (err) {
    if (ticket !== ytLookup) return;
    $('#ytPreview').hidden = true;
    showError('#upError', err);
  }
}

function openUpload() {
  $('#uploadForm').reset();
  chosenFile = null;
  titleAuto = false;
  ytLookup++;
  $('#ytPreview').hidden = true;
  setUploadMode('youtube');
  tagInputs.up.set(state.topic ? [state.topic] : []);
  $('#dropText').innerHTML = 'Drop a video here, or click to choose<br><small class="muted">MP4 or WebM play in every browser</small>';
  $('#upFolder').value = state.folder && state.folder !== 'none' ? state.folder : '';
  $('#upLevel').value = state.level;
  $('#upProgress').hidden = true;
  $('#upSubmit').disabled = false;
  showError('#upError', null);
  $('#uploadDialog').showModal();
}

async function submitUpload(e) {
  e.preventDefault();
  showError('#upError', null);
  if (uploadMode === 'youtube') return submitYouTube();
  if (!chosenFile) return showError('#upError', new Error('Choose a video file first'));
  const meta = {
    title: $('#upTitle').value,
    description: $('#upDesc').value,
    folderId: $('#upFolder').value || null,
    level: $('#upLevel').value,
    topics: tagInputs.up.get(),
    published: $('#upPublished').checked,
    durationSec: await readDuration(chosenFile),
  };
  $('#upSubmit').disabled = true;
  $('#upProgress').hidden = false;
  $('#upProgress').value = 0;

  // XMLHttpRequest (not fetch) so we can show upload progress.
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/videos');
  xhr.setRequestHeader('X-Filename', encodeURIComponent(chosenFile.name));
  xhr.setRequestHeader('X-Meta', encodeURIComponent(JSON.stringify(meta)));
  xhr.upload.onprogress = (ev) => ev.lengthComputable && ($('#upProgress').value = (ev.loaded / ev.total) * 100);
  xhr.onload = async () => {
    $('#upSubmit').disabled = false;
    if (xhr.status === 401) {
      showAuth({ needsSetup: false });
      return;
    }
    if (xhr.status === 201) {
      $('#uploadDialog').close();
      toast('Video uploaded');
      await refresh();
    } else {
      let msg = 'Upload failed';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
      $('#upProgress').hidden = true;
      showError('#upError', new Error(msg));
    }
  };
  xhr.onerror = () => {
    $('#upSubmit').disabled = false;
    $('#upProgress').hidden = true;
    showError('#upError', new Error('Could not reach the server. Is it still running?'));
  };
  xhr.send(chosenFile);
}

async function submitYouTube() {
  if (!$('#ytUrl').value.trim()) return showError('#upError', new Error('Paste a YouTube link first'));
  $('#upSubmit').disabled = true;
  try {
    await api('/api/videos/youtube', {
      method: 'POST',
      body: JSON.stringify({
        youtubeUrl: $('#ytUrl').value,
        title: $('#upTitle').value,
        description: $('#upDesc').value,
        folderId: $('#upFolder').value || null,
        level: $('#upLevel').value,
        topics: tagInputs.up.get(),
        published: $('#upPublished').checked,
      }),
    });
    $('#uploadDialog').close();
    toast('Video added');
    await refresh();
  } catch (err) {
    showError('#upError', err);
  } finally {
    $('#upSubmit').disabled = false;
  }
}

// ---------- edit ----------

function openVideo(id) {
  const v = state.videos.find((x) => x.id === id);
  if (!v) return;
  state.editing = v;
  const yt = v.source === 'youtube';
  $('#player').hidden = yt;
  $('#ytFrameWrap').hidden = !yt;
  $('#ytLink').hidden = !yt;
  if (yt) {
    $('#player').removeAttribute('src');
    $('#ytFrame').src = v.embedUrl;
    $('#ytWatch').href = v.watchUrl;
  } else {
    $('#player').src = v.url;
  }
  $('#edTitle').value = v.title;
  $('#edDesc').value = v.description;
  $('#edFolder').value = v.folderId || '';
  $('#edLevel').value = v.level;
  $('#edPublished').checked = v.published;
  tagInputs.ed.set(v.topics);
  $('#edInfo').textContent = [
    yt ? 'YouTube' : v.originalName,
    !yt && formatSize(v.size),
    v.durationSec && formatDuration(v.durationSec),
    `uploaded ${new Date(v.createdAt).toLocaleString()}`,
  ].filter(Boolean).join(' · ');
  showError('#edError', null);
  $('#videoDialog').showModal();
}

async function saveVideo(e) {
  e.preventDefault();
  try {
    await api(`/api/videos/${state.editing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: $('#edTitle').value,
        description: $('#edDesc').value,
        folderId: $('#edFolder').value || null,
        level: $('#edLevel').value,
        topics: tagInputs.ed.get(),
        published: $('#edPublished').checked,
      }),
    });
    $('#videoDialog').close();
    toast('Changes saved');
    await refresh();
  } catch (err) {
    showError('#edError', err);
  }
}

async function removeVideo() {
  if (!confirm(`Delete “${state.editing.title}”? The video file will be removed from this computer.`)) return;
  try {
    await api(`/api/videos/${state.editing.id}`, { method: 'DELETE' });
    $('#videoDialog').close();
    toast('Video deleted');
    await refresh();
  } catch (err) {
    showError('#edError', err);
  }
}

// ---------- folders ----------

function openFolder(id) {
  state.editingFolder = id ? state.folders.find((f) => f.id === id) : null;
  $('#folderDialogTitle').textContent = id ? 'Edit folder' : 'New folder';
  $('#folderName').value = state.editingFolder?.name || '';
  $('#deleteFolder').hidden = !id;
  showError('#folderError', null);
  $('#folderDialog').showModal();
}

async function saveFolder(e) {
  e.preventDefault();
  try {
    const name = $('#folderName').value;
    if (state.editingFolder) {
      await api(`/api/folders/${state.editingFolder.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    } else {
      const folder = await api('/api/folders', { method: 'POST', body: JSON.stringify({ name }) });
      state.folder = folder.id;
    }
    $('#folderDialog').close();
    await refresh();
  } catch (err) {
    showError('#folderError', err);
  }
}

async function removeFolder() {
  const f = state.editingFolder;
  if (!confirm(`Delete the folder “${f.name}”? Its ${f.count} video(s) are kept and move to Unfiled.`)) return;
  try {
    await api(`/api/folders/${f.id}`, { method: 'DELETE' });
    $('#folderDialog').close();
    toast('Folder deleted');
    await refresh();
  } catch (err) {
    showError('#folderError', err);
  }
}

// ---------- login ----------

let authMode = 'login';

function showAuth(status) {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  $('#appLayout').hidden = true;
  $('#topActions').hidden = true;
  $('#authScreen').hidden = false;
  showError('#authError', null);
  $('#authPassword').value = '';
  $('#authConfirm').value = '';

  if (status.needsSetup && status.canSetup) {
    authMode = 'setup';
    $('#authTitle').textContent = 'Create your teacher password';
    $('#authHelp').textContent = 'You will use this password to upload and manage videos. Students never need it.';
    $('#authPassword').autocomplete = 'new-password';
    $('#authConfirmField').hidden = false;
    $('#authConfirm').required = true;
    $('#authPasswordField').hidden = false;
    $('#authSubmit').hidden = false;
    $('#authSubmit').textContent = 'Create password';
  } else if (status.needsSetup) {
    authMode = 'blocked';
    $('#authTitle').textContent = 'Not set up yet';
    $('#authHelp').textContent = 'Open this app on the computer that runs the server to create the teacher password, or set TEACHER_PASSWORD where it is hosted.';
    $('#authPasswordField').hidden = true;
    $('#authConfirmField').hidden = true;
    $('#authSubmit').hidden = true;
  } else {
    authMode = 'login';
    $('#authTitle').textContent = 'Teacher login';
    $('#authHelp').textContent = 'Log in to upload and organize your lesson videos.';
    $('#authPassword').autocomplete = 'current-password';
    $('#authConfirmField').hidden = true;
    $('#authConfirm').required = false;
    $('#authPasswordField').hidden = false;
    $('#authSubmit').hidden = false;
    $('#authSubmit').textContent = 'Log in';
  }
  $('#authPassword').focus();
}

async function showApp() {
  $('#authScreen').hidden = true;
  $('#appLayout').hidden = false;
  $('#topActions').hidden = false;
  await refresh();
}

async function submitAuth(e) {
  e.preventDefault();
  showError('#authError', null);
  const password = $('#authPassword').value;
  try {
    if (authMode === 'setup') {
      if (password !== $('#authConfirm').value) throw new Error('The two passwords are different');
      await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password }) });
    } else {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
    }
    await showApp();
  } catch (err) {
    showError('#authError', err);
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  showAuth({ needsSetup: false });
}

function openPassword() {
  $('#passwordForm').reset();
  showError('#pwError', null);
  $('#passwordDialog').showModal();
}

async function changePassword(e) {
  e.preventDefault();
  try {
    if ($('#pwNext').value !== $('#pwConfirm').value) throw new Error('The two new passwords are different');
    await api('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ current: $('#pwCurrent').value, next: $('#pwNext').value }),
    });
    $('#passwordDialog').close();
    toast('Password changed');
  } catch (err) {
    showError('#pwError', err);
  }
}

// ---------- wiring ----------

function init() {
  setupTagInput('up');
  setupTagInput('ed');

  $('#openUpload').onclick = openUpload;
  $('#authForm').onsubmit = submitAuth;
  $('#logout').onclick = logout;
  $('#openPassword').onclick = openPassword;
  $('#passwordForm').onsubmit = changePassword;
  $('#newFolder').onclick = () => openFolder(null);
  $('#uploadForm').onsubmit = submitUpload;
  $('#editForm').onsubmit = saveVideo;
  $('#folderForm').onsubmit = saveFolder;
  $('#deleteVideo').onclick = removeVideo;
  $('#deleteFolder').onclick = removeFolder;
  $('#fileInput').onchange = (e) => chooseFile(e.target.files[0]);
  $('#videoDialog').addEventListener('close', () => {
    $('#player').pause();
    $('#ytFrame').src = 'about:blank'; // stops YouTube playback
  });
  document.querySelectorAll('.segmented [data-mode]').forEach((b) => (b.onclick = () => setUploadMode(b.dataset.mode)));
  $('#upTitle').addEventListener('input', () => (titleAuto = false));
  let ytTimer;
  $('#ytUrl').addEventListener('input', () => { clearTimeout(ytTimer); ytTimer = setTimeout(lookUpYouTube, 400); });

  document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => b.closest('dialog').close()));

  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    chooseFile(e.dataTransfer.files[0]);
  });

  document.addEventListener('click', (e) => {
    const editFolder = e.target.closest('[data-edit-folder]');
    if (editFolder) { e.stopPropagation(); return openFolder(editFolder.dataset.editFolder); }
    const folder = e.target.closest('[data-folder]');
    if (folder) { state.folder = folder.dataset.folder; return refresh(); }
    const level = e.target.closest('[data-level]');
    if (level) { state.level = state.level === level.dataset.level ? '' : level.dataset.level; return refresh(); }
    const topic = e.target.closest('[data-topic]');
    if (topic) { state.topic = state.topic === topic.dataset.topic ? '' : topic.dataset.topic; return refresh(); }
    const card = e.target.closest('[data-video]');
    if (card) return openVideo(card.dataset.video);
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'upload') return openUpload();
    if (action === 'clear') {
      Object.assign(state, { folder: '', level: '', topic: '', q: '' });
      $('#search').value = '';
      return refresh();
    }
  });

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = e.target.value.trim(); refresh(); }, 200);
  });
  $('#sort').onchange = (e) => { state.sort = e.target.value; refresh(); };

  api('/api/auth/status')
    .then((status) => {
      $('#openPassword').hidden = status.managedByEnv;
      return status.loggedIn ? showApp() : showAuth(status);
    })
    .catch((err) => toast(err.message));
}

init();
