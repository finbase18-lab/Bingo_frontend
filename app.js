// ============================================================
// BINGO MINI APP - STAGE 2: REAL CARD SELECTION
// ============================================================

// Change this ONE value after your Render backend is deployed.
const API_BASE_URL = "https://YOUR-RENDER-SERVICE.onrender.com";

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
let rooms = [];
let currentRoomData = null;
let selectedCardIds = new Set();
let modalPollTimer = null;

function initTelegram() {
    if (!tg) return;
    tg.ready();
    tg.expand();
    if (tg.setHeaderColor) tg.setHeaderColor("#070b16");
    if (tg.setBackgroundColor) tg.setBackgroundColor("#070b16");
}

function headers() {
    if (!tg || !tg.initData) throw new Error("Open this page from the Telegram Mini App.");
    return { "Content-Type": "application/json", "X-Telegram-Init-Data": tg.initData };
}

async function api(path, options = {}) {
    const response = await fetch(API_BASE_URL + path, {
        ...options,
        headers: { ...headers(), ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "Request failed");
    return data;
}

function money(value) {
    return Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusLabel(status) {
    const map = { WAITING: "WAITING", COUNTDOWN: "COUNTDOWN", PLAYING: "LIVE", WINNER: "WINNER", RESULT: "RESULT", FINISHED: "FINISHED" };
    return map[status] || status || "WAITING";
}

function renderUser(user) {
    document.getElementById("playerName").textContent = user.display_name || "Player";
    document.getElementById("totalBalance").textContent = money(user.balance);
    document.getElementById("mainBalance").textContent = money(user.main_balance);
    document.getElementById("bonusBalance").textContent = money(user.bonus_balance);
    document.getElementById("withdrawableBalance").textContent = money(user.withdrawable_balance);
}

function renderRooms() {
    const container = document.getElementById("rooms");
    container.innerHTML = "";
    rooms.forEach(room => {
        const status = room.status || "WAITING";
        const players = Number(room.active_players || 0);
        const maxPlayers = Number(room.max_players || 0);
        const prize = Number(room.prize_pool || (room.bet_amount * players * (1 - Number(room.commission_percent || 0) / 100)));
        const canOpen = ["WAITING", "COUNTDOWN", "PLAYING"].includes(status);
        const buttonText = status === "PLAYING" ? "WATCH" : "CHOOSE CARD";
        const card = document.createElement("article");
        card.className = "room-card";
        card.innerHTML = `
            <div class="room-top">
                <div><div class="eyebrow">ROUND ${room.round_number || "—"}</div><div class="room-title">🎱 Bingo ${money(room.bet_amount)}</div></div>
                <span class="room-status ${status.toLowerCase()}">${statusLabel(status)}</span>
            </div>
            <div class="room-meta">
                <div class="meta-box"><span>Players</span><strong>${players}/${maxPlayers}</strong></div>
                <div class="meta-box"><span>Pot</span><strong>${money(room.total_pot)}</strong></div>
                <div class="meta-box"><span>Prize</span><strong class="prize">${money(prize)}</strong></div>
            </div>
            <div class="room-bottom">
                <div class="players">${room.selected_cards || 0} cards selected · ${room.countdown_seconds || 60}s countdown</div>
                <button class="join-btn" ${canOpen ? "" : "disabled"} data-room="${room.room_id}">${buttonText}</button>
            </div>`;
        container.appendChild(card);
    });
    container.querySelectorAll(".join-btn").forEach(button => button.addEventListener("click", () => openRoom(Number(button.dataset.room))));
}

async function loadDashboard() {
    document.getElementById("loading").classList.remove("hidden");
    document.getElementById("error").classList.add("hidden");
    try {
        const data = await api("/api/bingo/dashboard");
        renderUser(data.user);
        rooms = data.rooms || [];
        renderRooms();
    } catch (error) {
        const box = document.getElementById("error");
        box.textContent = error.message;
        box.classList.remove("hidden");
    } finally {
        document.getElementById("loading").classList.add("hidden");
    }
}

function parseCardData(card) {
    try {
        const grid = typeof card.card_data === "string" ? JSON.parse(card.card_data) : card.card_data;
        return Array.isArray(grid) ? grid : [];
    } catch (_) { return []; }
}

function createBingoCard(card, state, selectable) {
    const grid = parseCardData(card);
    const cardEl = document.createElement("div");
    const selected = selectedCardIds.has(Number(card.id));
    const locked = !selectable;
    cardEl.className = `bingo-card ${selected ? "selected" : ""} ${locked ? "locked" : "available"}`;
    cardEl.dataset.cardId = card.id;

    const label = document.createElement("div");
    label.className = "card-label";
    label.innerHTML = `<span>Card #${card.card_number}</span><span>${selected ? "SELECTED" : (locked ? "TAKEN" : "AVAILABLE")}</span>`;
    cardEl.appendChild(label);

    const bingoGrid = document.createElement("div");
    bingoGrid.className = "bingo-grid";
    ["B", "I", "N", "G", "O"].forEach(letter => {
        const h = document.createElement("div"); h.className = "bingo-head"; h.textContent = letter; bingoGrid.appendChild(h);
    });
    for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 5; col++) {
            const cell = document.createElement("div");
            cell.className = "bingo-cell";
            const value = grid[row] && grid[row][col] !== undefined ? grid[row][col] : "—";
            if (Number(value) === 0) { cell.textContent = "FREE"; cell.classList.add("free"); }
            else cell.textContent = value;
            bingoGrid.appendChild(cell);
        }
    }
    cardEl.appendChild(bingoGrid);

    if (selectable) {
        cardEl.addEventListener("click", () => {
            const id = Number(card.id);
            if (selectedCardIds.has(id)) selectedCardIds.delete(id);
            else selectedCardIds.add(id);
            renderCardSelection(state);
        });
    }
    return cardEl;
}

function renderCardSelection(data) {
    currentRoomData = data;
    const round = data.round || {};
    const room = data.room || {};
    const players = data.players || [];
    const available = data.available_cards || [];
    const myCards = data.my_cards || [];
    const isOpen = ["WAITING", "COUNTDOWN"].includes(round.status);

    document.getElementById("modalEyebrow").textContent = `ROUND ${round.round_number || "—"} · ${statusLabel(round.status)}`;
    document.getElementById("modalTitle").textContent = `Bingo ${money(room.bet_amount)}`;
    document.getElementById("roomSummary").innerHTML = `
        <div class="summary-item"><span>Players</span><strong>${players.length}/${room.max_players || "—"}</strong></div>
        <div class="summary-item"><span>Pot</span><strong>${money(round.total_pot)}</strong></div>
        <div class="summary-item"><span>Prize</span><strong>${money(round.prize_pool)}</strong></div>
        <div class="summary-item"><span>Countdown</span><strong>${data.countdown_remaining || 0}s</strong></div>`;

    const notice = document.getElementById("spectatorNotice");
    if (!isOpen) {
        notice.textContent = "This round has already started. You can watch this round. Card selection will be available when the round ends.";
        notice.classList.remove("hidden");
    } else notice.classList.add("hidden");

    document.getElementById("selectedCount").textContent = selectedCardIds.size;
    document.getElementById("selectedCost").textContent = money(selectedCardIds.size * Number(room.bet_amount || 0));

    const mineSection = document.getElementById("myCardsSection");
    const mineGrid = document.getElementById("myCards");
    mineGrid.innerHTML = "";
    if (myCards.length) {
        mineSection.classList.remove("hidden");
        myCards.forEach(card => mineGrid.appendChild(createBingoCard(card, data, false)));
    } else mineSection.classList.add("hidden");

    const grid = document.getElementById("cardsGrid");
    grid.innerHTML = "";
    if (!available.length) {
        grid.innerHTML = `<div class="notice">No cards are currently available in this round.</div>`;
    } else {
        available.forEach(card => grid.appendChild(createBingoCard(card, data, isOpen)));
    }

    const joinBtn = document.getElementById("joinSelectedBtn");
    joinBtn.disabled = !isOpen || selectedCardIds.size === 0;
    joinBtn.textContent = isOpen ? `Join with ${selectedCardIds.size || "selected"} card${selectedCardIds.size === 1 ? "" : "s"}` : "Round already started";
}

async function openRoom(roomId) {
    try {
        const data = await api(`/api/bingo/rooms/${roomId}`);
        selectedCardIds = new Set();
        (data.my_cards || []).forEach(card => selectedCardIds.delete(Number(card.id)));
        renderCardSelection(data);
        document.getElementById("roomModal").classList.remove("hidden");
        startModalPolling();
    } catch (error) { showToast(error.message); }
}

async function refreshOpenRoom() {
    if (!currentRoomData) return;
    const roomId = Number(currentRoomData.room.id);
    try {
        const data = await api(`/api/bingo/rooms/${roomId}`);
        // Keep selections only for cards that are still available.
        const availableIds = new Set((data.available_cards || []).map(c => Number(c.id)));
        selectedCardIds = new Set([...selectedCardIds].filter(id => availableIds.has(id)));
        renderCardSelection(data);
    } catch (_) {}
}

function startModalPolling() {
    clearInterval(modalPollTimer);
    modalPollTimer = setInterval(refreshOpenRoom, 3000);
}

function closeModal() {
    clearInterval(modalPollTimer);
    modalPollTimer = null;
    currentRoomData = null;
    document.getElementById("roomModal").classList.add("hidden");
}

async function joinSelectedCards() {
    if (!currentRoomData || selectedCardIds.size === 0) return;
    const roomId = Number(currentRoomData.room.id);
    const ids = [...selectedCardIds];
    const button = document.getElementById("joinSelectedBtn");
    button.disabled = true;
    try {
        let joined = 0;
        for (const cardId of ids) {
            await api(`/api/bingo/rooms/${roomId}/join`, {
                method: "POST",
                body: JSON.stringify({ card_id: cardId }),
            });
            joined++;
        }
        selectedCardIds.clear();
        showToast(`${joined} Bingo card${joined === 1 ? "" : "s"} selected successfully`);
        await loadDashboard();
        const data = await api(`/api/bingo/rooms/${roomId}`);
        renderCardSelection(data);
    } catch (error) {
        showToast(error.message);
        await refreshOpenRoom();
    } finally {
        button.disabled = false;
    }
}

function showToast(message) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 2800);
}

document.getElementById("refreshBtn").addEventListener("click", loadDashboard);
document.getElementById("closeModal").addEventListener("click", closeModal);
document.getElementById("modalBackdrop").addEventListener("click", closeModal);
document.getElementById("joinSelectedBtn").addEventListener("click", joinSelectedCards);

document.addEventListener("DOMContentLoaded", async () => {
    initTelegram();
    await loadDashboard();
});
