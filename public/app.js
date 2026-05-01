const audio = document.querySelector("#audio");
const youtubeShell = document.querySelector("#youtubeShell");
const youtubeInput = document.querySelector("#youtubeInput");
const loadYoutubeVideoBtn = document.querySelector("#loadYoutubeVideoBtn");
const loadYoutubeLiteBtn = document.querySelector("#loadYoutubeLiteBtn");
const playBtn = document.querySelector("#playBtn");
const playIcon = document.querySelector("#playIcon");
const rewindBtn = document.querySelector("#rewindBtn");
const forwardBtn = document.querySelector("#forwardBtn");
const seek = document.querySelector("#seek");
const currentTime = document.querySelector("#currentTime");
const duration = document.querySelector("#duration");
const createRoomBtn = document.querySelector("#createRoomBtn");
const copyLinkBtn = document.querySelector("#copyLinkBtn");
const fileInput = document.querySelector("#fileInput");
const fileName = document.querySelector("#fileName");
const urlInput = document.querySelector("#urlInput");
const loadUrlBtn = document.querySelector("#loadUrlBtn");
const roomCode = document.querySelector("#roomCode");
const sourceText = document.querySelector("#sourceText");
const modeText = document.querySelector("#modeText");
const driftText = document.querySelector("#driftText");
const syncNowBtn = document.querySelector("#syncNowBtn");
const songTitle = document.querySelector("#songTitle");
const syncStatus = document.querySelector("#syncStatus");
const presenceText = document.querySelector("#presenceText");
const presenceDot = document.querySelector("#presenceDot");
const record = document.querySelector("#record");
const recordInitials = document.querySelector("#recordInitials");
const nameInput = document.querySelector("#nameInput");
const noteForm = document.querySelector("#noteForm");
const noteInput = document.querySelector("#noteInput");
const loveNotes = document.querySelector("#loveNotes");
const noteCount = document.querySelector("#noteCount");
const moodChips = document.querySelectorAll(".mood-chip");
const quickNotes = document.querySelectorAll(".quick-notes button");
const messageForm = document.querySelector("#messageForm");
const messageInput = document.querySelector("#messageInput");
const messages = document.querySelector("#messages");
const messageCount = document.querySelector("#messageCount");

const params = new URLSearchParams(window.location.search);
const clientId = localStorage.getItem("tt-client-id") || crypto.randomUUID();
localStorage.setItem("tt-client-id", clientId);

let roomId = params.get("room") || "";
let eventSource = null;
let isApplyingRemote = false;
let lastRemoteState = null;
let chatCount = 0;
let mediaType = "audio";
let youtubeId = "";
let youtubeMode = "video";
let youtubePlayer = null;
let youtubeReady = false;
let pendingYoutubeState = null;
let selectedMood = "Missing you";
let noteTotal = 0;

nameInput.value = localStorage.getItem("tt-name") || "";

function formatTime(value) {
  if (!Number.isFinite(value)) return "0:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function getDisplayName() {
  return nameInput.value.trim() || "Guest";
}

function setStatus(text) {
  syncStatus.textContent = text;
}

function loadYoutubeApi() {
  if (window.YT?.Player || document.querySelector("script[data-youtube-api]")) return;
  const script = document.createElement("script");
  script.src = "https://www.youtube.com/iframe_api";
  script.dataset.youtubeApi = "true";
  document.head.appendChild(script);
}

window.onYouTubeIframeAPIReady = () => {
  youtubePlayer = new YT.Player("youtubePlayer", {
    width: "100%",
    height: "100%",
    playerVars: {
      playsinline: 1,
      rel: 0,
      modestbranding: 1,
      origin: window.location.origin
    },
    events: {
      onReady: () => {
        youtubeReady = true;
        if (mediaType === "youtube" && youtubeId) {
          youtubePlayer.cueVideoById(youtubeId);
        }
        if (pendingYoutubeState) applyRemoteState(pendingYoutubeState, true);
      },
      onStateChange: (event) => {
        if (isApplyingRemote || mediaType !== "youtube") return;
        if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.PAUSED) {
          publishState();
        }
      }
    }
  });
};

function parseYoutubeId(value) {
  try {
    const url = new URL(value.trim());
    if (url.hostname.includes("youtu.be")) return url.pathname.split("/").filter(Boolean)[0] || "";
    if (url.searchParams.get("v")) return url.searchParams.get("v");
    const shorts = url.pathname.match(/\/shorts\/([^/?]+)/);
    if (shorts) return shorts[1];
    const embed = url.pathname.match(/\/embed\/([^/?]+)/);
    if (embed) return embed[1];
  } catch {
    return "";
  }
  return "";
}

function getYoutubeTime() {
  if (!youtubePlayer?.getCurrentTime) return 0;
  return youtubePlayer.getCurrentTime() || 0;
}

function getYoutubeDuration() {
  if (!youtubePlayer?.getDuration) return 0;
  return youtubePlayer.getDuration() || 0;
}

function isYoutubePlaying() {
  if (!youtubePlayer?.getPlayerState || !window.YT) return false;
  return youtubePlayer.getPlayerState() === YT.PlayerState.PLAYING;
}

async function ensureRoom() {
  if (roomId) return roomId;
  const room = await postJson("/api/room", {});
  setRoom(room.roomId);
  modeText.textContent = "Host";
  return room.roomId;
}

function setRoom(id) {
  roomId = id;
  roomCode.textContent = id || "None";
  if (id) {
    params.set("room", id);
    window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
    connectRoom();
  }
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function currentState() {
  if (mediaType === "youtube") {
    return {
      clientId,
      title: songTitle.textContent,
      sourceName: sourceText.textContent === "No song" ? "" : sourceText.textContent,
      sourceUrl: youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : "",
      mediaType: "youtube",
      youtubeId,
      youtubeMode,
      isPlaying: isYoutubePlaying(),
      position: getYoutubeTime()
    };
  }

  return {
    clientId,
    title: songTitle.textContent,
    sourceName: sourceText.textContent === "No song" ? "" : sourceText.textContent,
    sourceUrl: audio.dataset.remoteUrl || "",
    mediaType: "audio",
    youtubeId: "",
    youtubeMode: "video",
    isPlaying: !audio.paused,
    position: audio.currentTime || 0
  };
}

async function publishState() {
  if (!roomId || isApplyingRemote) return;
  try {
    await postJson(`/api/rooms/${roomId}/state`, currentState());
  } catch (error) {
    setStatus("Sync server is not reachable yet.");
  }
}

function expectedPosition(state) {
  if (!state) return 0;
  const elapsed = state.isPlaying ? (Date.now() - state.updatedAt) / 1000 : 0;
  return Math.max(0, Number(state.position || 0) + elapsed);
}

async function applyRemoteState(state, force = false) {
  if (!state || state.hostId === clientId) return;
  lastRemoteState = state;
  modeText.textContent = "Guest";
  songTitle.textContent = state.title || "Shared song";
  sourceText.textContent = state.sourceName || "Shared source";
  recordInitials.textContent = (state.title || "LS").slice(0, 2).toUpperCase();

  if (state.mediaType === "youtube") {
    await applyYoutubeState(state, force);
    return;
  }

  setMediaShell("audio");
  if (state.sourceUrl && audio.dataset.remoteUrl !== state.sourceUrl) {
    audio.dataset.remoteUrl = state.sourceUrl;
    audio.src = state.sourceUrl;
  }

  const target = expectedPosition(state);
  const drift = Math.abs((audio.currentTime || 0) - target);
  driftText.textContent = `${drift.toFixed(2)}s`;

  if (!audio.src && !state.sourceUrl) {
    setStatus("Waiting for your host to upload a song.");
    return;
  }

  if (force || drift > 0.75) {
    isApplyingRemote = true;
    audio.currentTime = target;
    isApplyingRemote = false;
  }

  if (state.isPlaying && audio.paused) {
    try {
      isApplyingRemote = true;
      await audio.play();
    } catch {
      setStatus("Tap Play once so your browser allows synced playback.");
    } finally {
      isApplyingRemote = false;
    }
  }

  if (!state.isPlaying && !audio.paused) {
    isApplyingRemote = true;
    audio.pause();
    isApplyingRemote = false;
  }
}

async function applyYoutubeState(state, force = false) {
  mediaType = "youtube";
  youtubeId = state.youtubeId || parseYoutubeId(state.sourceUrl || "");
  youtubeMode = state.youtubeMode || "video";
  setMediaShell("youtube");
  loadYoutubeApi();

  if (!youtubeReady || !youtubePlayer) {
    pendingYoutubeState = state;
    setStatus("Loading the YouTube player.");
    return;
  }

  pendingYoutubeState = null;
  const target = expectedPosition(state);
  const currentVideo = youtubePlayer.getVideoData?.().video_id;
  isApplyingRemote = true;
  if (youtubeId && currentVideo !== youtubeId) {
    youtubePlayer.cueVideoById({ videoId: youtubeId, startSeconds: target });
  } else if (force || Math.abs(getYoutubeTime() - target) > 0.75) {
    youtubePlayer.seekTo(target, true);
  }

  if (state.isPlaying) {
    youtubePlayer.playVideo();
  } else {
    youtubePlayer.pauseVideo();
  }
  isApplyingRemote = false;
  updateProgress();
  setStatus(youtubeMode === "lite" ? "YouTube Lite Video is synced." : "YouTube video is synced.");
}

function connectRoom() {
  if (!roomId) return;
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`/api/rooms/${roomId}/events?clientId=${encodeURIComponent(clientId)}`);
  setStatus(`Connected to room ${roomId}.`);

  eventSource.addEventListener("hello", (event) => {
    const payload = JSON.parse(event.data);
    roomCode.textContent = roomId;
    if (payload.state?.hostId && payload.state.hostId !== clientId) {
      applyRemoteState(payload.state, true);
    }
    (payload.messages || []).forEach(addMessage);
  });

  eventSource.addEventListener("state", (event) => {
    applyRemoteState(JSON.parse(event.data));
  });

  eventSource.addEventListener("presence", (event) => {
    const { count } = JSON.parse(event.data);
    presenceText.textContent = count > 1 ? `${count} listening` : "Solo";
    presenceDot.classList.toggle("live", count > 1);
  });

  eventSource.addEventListener("message", (event) => {
    addMessage(JSON.parse(event.data));
  });

  eventSource.onerror = () => {
    setStatus("Trying to reconnect to the room.");
  };
}

function setAudioSource(src, label, isRemoteUrl = true) {
  mediaType = "audio";
  youtubeId = "";
  setMediaShell("audio");
  audio.src = src;
  audio.dataset.remoteUrl = isRemoteUrl ? src : "";
  sourceText.textContent = label;
  songTitle.textContent = label.replace(/\.[^/.]+$/, "") || "Shared song";
  recordInitials.textContent = songTitle.textContent.slice(0, 2).toUpperCase();
  setStatus("Song loaded for everyone in the room.");
  publishState();
}

async function setYoutubeSource(id, mode) {
  if (!id) {
    setStatus("Paste a valid YouTube link.");
    return;
  }

  await ensureRoom();
  mediaType = "youtube";
  youtubeId = id;
  youtubeMode = mode;
  audio.pause();
  setMediaShell("youtube");
  loadYoutubeApi();
  const label = `YouTube ${mode === "lite" ? "Lite Video" : "Video"}`;
  sourceText.textContent = label;
  songTitle.textContent = "YouTube song";
  recordInitials.textContent = "YT";
  setStatus(mode === "lite" ? "Lite video mode loaded. YouTube audio-only is not allowed, so the compact player stays visible." : "YouTube video loaded for this room.");

  if (youtubeReady && youtubePlayer) {
    youtubePlayer.cueVideoById(id);
  }
  publishState();
}

function setMediaShell(type) {
  mediaType = type;
  audio.classList.toggle("is-hidden", type !== "audio");
  youtubeShell.classList.toggle("is-hidden", type !== "youtube");
  youtubeShell.classList.toggle("lite", type === "youtube" && youtubeMode === "lite");
}

async function uploadSong(file) {
  const activeRoom = await ensureRoom();
  const form = new FormData();
  form.append("clientId", clientId);
  form.append("song", file);
  setStatus("Uploading the song for your partner...");
  fileName.textContent = file.name;

  const response = await fetch(`/api/rooms/${activeRoom}/upload`, {
    method: "POST",
    body: form
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Upload failed" }));
    throw new Error(error.error || "Upload failed");
  }

  const uploaded = await response.json();
  setAudioSource(uploaded.sourceUrl, uploaded.sourceName, true);
  setStatus("Uploaded. Your partner can listen from this room link.");
}

function updatePlayUi() {
  const playing = mediaType === "youtube" ? isYoutubePlaying() : !audio.paused;
  playIcon.textContent = playing ? "Pause" : "Play";
  playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  record.classList.toggle("playing", playing);
}

function updateProgress() {
  const activeTime = mediaType === "youtube" ? getYoutubeTime() : audio.currentTime;
  const total = mediaType === "youtube" ? getYoutubeDuration() : audio.duration || 0;
  const value = total ? (activeTime / total) * 1000 : 0;
  seek.value = String(value);
  currentTime.textContent = formatTime(activeTime);
  duration.textContent = formatTime(total);
}

function addMessage(message) {
  if (!message?.text || document.querySelector(`[data-message-id="${message.id}"]`)) return;
  if (message.kind === "note") {
    addLoveNote(message);
    return;
  }

  const bubble = document.createElement("div");
  bubble.className = `message${message.sender === getDisplayName() ? " own" : ""}`;
  bubble.dataset.messageId = message.id;
  const sender = document.createElement("small");
  sender.textContent = message.sender;
  const text = document.createElement("span");
  text.textContent = message.text;
  bubble.append(sender, text);
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
  chatCount += 1;
  messageCount.textContent = String(chatCount);
}

function addLoveNote(message) {
  const card = document.createElement("article");
  card.className = `love-note${message.sender === getDisplayName() ? " own" : ""}`;
  card.dataset.messageId = message.id;

  const meta = document.createElement("div");
  meta.className = "note-meta";
  const mood = document.createElement("span");
  mood.textContent = message.mood || "Love note";
  const sender = document.createElement("strong");
  sender.textContent = message.sender;
  meta.append(mood, sender);

  const text = document.createElement("p");
  text.textContent = message.text;
  card.append(meta, text);
  loveNotes.prepend(card);
  noteTotal += 1;
  noteCount.textContent = String(noteTotal);
}

async function sendRoomMessage({ text, kind = "chat", mood = "" }) {
  if (!roomId) await ensureRoom();
  if (!text.trim()) return;
  await postJson(`/api/rooms/${roomId}/message`, {
    sender: getDisplayName(),
    text: text.trim(),
    kind,
    mood
  });
}

createRoomBtn.addEventListener("click", async () => {
  await ensureRoom();
  modeText.textContent = "Host";
  setStatus("Love room created. Share the link with your partner.");
});

copyLinkBtn.addEventListener("click", async () => {
  await ensureRoom();
  await navigator.clipboard.writeText(window.location.href);
  setStatus("Room link copied.");
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    await uploadSong(file);
  } catch (error) {
    setStatus(error.message);
  }
});

loadUrlBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) return;
  try {
    new URL(url);
    await ensureRoom();
    setAudioSource(url, url.split("/").pop() || "Shared audio URL", true);
  } catch {
    setStatus("That audio URL does not look valid.");
  }
});

loadYoutubeVideoBtn.addEventListener("click", async () => {
  await setYoutubeSource(parseYoutubeId(youtubeInput.value), "video");
});

loadYoutubeLiteBtn.addEventListener("click", async () => {
  await setYoutubeSource(parseYoutubeId(youtubeInput.value), "lite");
});

playBtn.addEventListener("click", async () => {
  if (mediaType === "youtube") {
    if (!youtubeReady || !youtubePlayer || !youtubeId) {
      setStatus("Load a YouTube song first.");
      return;
    }
    if (isYoutubePlaying()) {
      youtubePlayer.pauseVideo();
    } else {
      youtubePlayer.playVideo();
    }
    publishState();
    updatePlayUi();
    return;
  }

  if (!audio.src) {
    setStatus("Load a song first.");
    return;
  }
  if (audio.paused) {
    await audio.play();
  } else {
    audio.pause();
  }
  publishState();
});

rewindBtn.addEventListener("click", () => {
  if (mediaType === "youtube") {
    youtubePlayer?.seekTo(Math.max(0, getYoutubeTime() - 10), true);
    publishState();
    return;
  }
  audio.currentTime = Math.max(0, audio.currentTime - 10);
  publishState();
});

forwardBtn.addEventListener("click", () => {
  if (mediaType === "youtube") {
    youtubePlayer?.seekTo(Math.min(getYoutubeDuration() || getYoutubeTime() + 10, getYoutubeTime() + 10), true);
    publishState();
    return;
  }
  audio.currentTime = Math.min(audio.duration || audio.currentTime + 10, audio.currentTime + 10);
  publishState();
});

seek.addEventListener("input", () => {
  if (mediaType === "youtube") {
    const total = getYoutubeDuration();
    if (!total) return;
    youtubePlayer?.seekTo((Number(seek.value) / 1000) * total, true);
    return;
  }
  if (!audio.duration) return;
  audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
});

seek.addEventListener("change", publishState);
syncNowBtn.addEventListener("click", () => applyRemoteState(lastRemoteState, true));

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await sendRoomMessage({ text: messageInput.value, kind: "chat" });
  messageInput.value = "";
});

noteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await sendRoomMessage({ text: noteInput.value, kind: "note", mood: selectedMood });
  noteInput.value = "";
});

moodChips.forEach((chip) => {
  chip.addEventListener("click", () => {
    moodChips.forEach((item) => item.classList.remove("active"));
    chip.classList.add("active");
    selectedMood = chip.dataset.mood || "Love note";
  });
});

quickNotes.forEach((button) => {
  button.addEventListener("click", () => {
    noteInput.value = button.dataset.note || "";
    noteInput.focus();
  });
});

nameInput.addEventListener("input", () => {
  localStorage.setItem("tt-name", nameInput.value.trim());
});

audio.addEventListener("play", updatePlayUi);
audio.addEventListener("pause", updatePlayUi);
audio.addEventListener("timeupdate", updateProgress);
audio.addEventListener("loadedmetadata", updateProgress);
audio.addEventListener("seeked", () => {
  if (!isApplyingRemote) publishState();
});
audio.addEventListener("ended", publishState);

setInterval(() => {
  if (!lastRemoteState || lastRemoteState.hostId === clientId) return;
  const target = expectedPosition(lastRemoteState);
  const drift = Math.abs((audio.currentTime || 0) - target);
  driftText.textContent = `${drift.toFixed(2)}s`;
  if (lastRemoteState.isPlaying && drift > 1.5) applyRemoteState(lastRemoteState, true);
}, 2500);

setInterval(() => {
  if (mediaType === "youtube") {
    updateProgress();
    updatePlayUi();
  }
}, 500);

if (roomId) {
  setRoom(roomId);
} else {
  roomCode.textContent = "None";
}

updatePlayUi();
updateProgress();
loadYoutubeApi();
