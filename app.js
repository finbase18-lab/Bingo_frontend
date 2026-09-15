// ============================================================
// BINGO MINI APP - STAGE 2: REAL CARD SELECTION
// ============================================================

// Change this ONE value after your Render backend is deployed.
const API_BASE_URL = "https://bingo-backend-p3z5.onrender.com";

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
    container.querySelectorAll(".join-btn").forEach(button => button.addEventListener("click", () => {
        const room = rooms.find(r => Number(r.room_id) === Number(button.dataset.room));
        if (room && room.status === "PLAYING") openGame(Number(button.dataset.room));
        else openRoom(Number(button.dataset.room));
    }));
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

function createCardNumberButton(card, state, selectable) {
    const button = document.createElement("button");
    const id = Number(card.id);
    const selected = selectedCardIds.has(id);
    button.type = "button";
    button.className = `card-number ${selected ? "selected" : ""}`;
    button.textContent = `Cartel ${card.card_number}`;
    button.dataset.cardId = id;

    if (!selectable) {
        button.disabled = true;
        button.classList.add("locked");
    } else {
        button.addEventListener("click", () => {
            if (selectedCardIds.has(id)) selectedCardIds.delete(id);
            else selectedCardIds.add(id);
            renderCardSelection(state);
        });
    }
    return button;
}

function renderCardGrid(card, calledNumbers = []) {
    const grid = parseCardData(card);
    const called = new Set(calledNumbers.map(Number));
    const el = document.createElement("div");
    el.className = "game-card";

    const title = document.createElement("div");
    title.className = "game-card-title";
    title.innerHTML = `<strong>Cartel #${card.card_number}</strong><span>IN PLAY</span>`;
    el.appendChild(title);

    const bingoGrid = document.createElement("div");
    bingoGrid.className = "bingo-grid game-grid";

    ["B", "I", "N", "G", "O"].forEach(letter => {
        const h = document.createElement("div");
        h.className = "bingo-head";
        h.textContent = letter;
        bingoGrid.appendChild(h);
    });

    for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 5; col++) {
            const cell = document.createElement("div");
            cell.className = "bingo-cell";
            const value = grid[row] && grid[row][col] !== undefined ? grid[row][col] : "—";
            if (Number(value) === 0) {
                cell.textContent = "FREE";
                cell.classList.add("free", "marked");
            } else {
                cell.textContent = value;
                if (called.has(Number(value))) cell.classList.add("marked");
            }
            bingoGrid.appendChild(cell);
        }
    }

    el.appendChild(bingoGrid);
    return el;
}

function renderCardSelection(data) {
    currentRoomData = data;
    const round = data.round || {};
    const room = data.room || {};
    const players = data.players || [];
    const available = data.available_cards || [];
    const myCards = data.my_cards || [];
    const isOpen = ["WAITING", "COUNTDOWN"].includes(round.status);

    document.getElementById("modalEyebrow").textContent =
        `ROUND ${round.round_number || "—"} · ${statusLabel(round.status)}`;
    document.getElementById("modalTitle").textContent =
        `Choose a Cartel · Bingo ${money(room.bet_amount)}`;

    document.getElementById("roomSummary").innerHTML = `
        <div class="summary-item"><span>Players</span><strong>${players.length}/${room.max_players || "—"}</strong></div>
        <div class="summary-item"><span>Pot</span><strong>${money(round.total_pot)}</strong></div>
        <div class="summary-item"><span>Prize</span><strong>${money(round.prize_pool)}</strong></div>
        <div class="summary-item"><span>Countdown</span><strong>${data.countdown_remaining || 0}s</strong></div>`;

    const notice = document.getElementById("spectatorNotice");
    if (!isOpen) {
        notice.textContent =
            "This round has already started. You can watch this round. Cartel selection will be available when the round ends.";
        notice.classList.remove("hidden");
    } else {
        notice.classList.add("hidden");
    }

    document.getElementById("selectedCount").textContent = selectedCardIds.size;
    document.getElementById("selectedCost").textContent =
        money(selectedCardIds.size * Number(room.bet_amount || 0));

    const mineSection = document.getElementById("myCardsSection");
    const mineGrid = document.getElementById("myCards");
    mineGrid.innerHTML = "";
    if (myCards.length) {
        mineSection.classList.remove("hidden");
        myCards.forEach(card => {
            const b = document.createElement("button");
            b.className = "card-number locked";
            b.disabled = true;
            b.textContent = `Cartel ${card.card_number} · SELECTED`;
            mineGrid.appendChild(b);
        });
    } else {
        mineSection.classList.add("hidden");
    }

    document.getElementById("cardsGridTitle").textContent =
        isOpen ? "Available Cartels" : "Cartels";
    const grid = document.getElementById("cardsGrid");
    grid.innerHTML = "";

    if (!available.length) {
        grid.innerHTML = `<div class="notice">No cartels are currently available.</div>`;
    } else {
        available.forEach(card => grid.appendChild(createCardNumberButton(card, data, isOpen)));
    }

    const joinBtn = document.getElementById("joinSelectedBtn");
    joinBtn.disabled = !isOpen || selectedCardIds.size === 0;
    joinBtn.textContent = isOpen
        ? `Join with ${selectedCardIds.size || "selected"} cartel${selectedCardIds.size === 1 ? "" : "s"}`
        : "Round already started";
}

async function openRoom(roomId) {
    try {
        const data = await api(`/api/bingo/rooms/${roomId}`);
        selectedCardIds = new Set();
        renderCardSelection(data);
        document.getElementById("roomModal").classList.remove("hidden");
        startModalPolling();
    } catch (error) {
        showToast(error.message);
    }
}

async function refreshOpenRoom() {
    if (!currentRoomData) return;
    const roomId = Number(currentRoomData.room.id);
    try {
        const data = await api(`/api/bingo/rooms/${roomId}`);
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
        closeModal();
        showToast(`${joined} cartel${joined === 1 ? "" : "s"} selected successfully`);
        await loadDashboard();
        await openGame(roomId);
    } catch (error) {
        showToast(error.message);
        await refreshOpenRoom();
    } finally {
        button.disabled = false;
    }
}

let gamePollTimer = null;
let currentGameRoundId = null;

async function loadMyCards(roundId) {
    const data = await api(`/api/bingo/rounds/${roundId}/my-cards`);
    return data.cards || [];
}

function renderGame(data, myCards) {
    const round = data.round || {};
    const room = currentRoomData?.room || {};
    document.getElementById("gameTitle").textContent = `Bingo ${money(room.bet_amount)}`;
    document.getElementById("gameStatus").textContent = statusLabel(round.status);

    const called = data.called_numbers || [];
    const last = data.last_called;
    document.getElementById("lastCalled").textContent = last ?? "—";
    document.getElementById("calledCount").textContent = called.length;

    const calledBox = document.getElementById("calledNumbers");
    calledBox.innerHTML = called.map(n => `<span>${n}</span>`).join("");

    const players = data.players || [];
    document.getElementById("gamePlayers").textContent = `${players.length}`;
    document.getElementById("gamePrize").textContent = money((data.financials || {}).prize_pool ?? round.prize_pool ?? 0);

    const countdown = document.getElementById("gameCountdown");
    if (round.status === "COUNTDOWN") {
        countdown.classList.remove("hidden");
        countdown.textContent = `${data.countdown_remaining || 0}s`;
    } else {
        countdown.classList.add("hidden");
    }

    const cards = document.getElementById("gameCards");
    cards.innerHTML = "";

    if (myCards.length) {
        myCards.forEach(card => cards.appendChild(renderCardGrid(card, called)));
    } else {
        cards.innerHTML = `
            <div class="notice">
                👀 You are watching this round. The active player's cartels are hidden.
                You can select a cartel after the round ends.
            </div>`;
    }

    const winnerBox = document.getElementById("winnerNotice");
    if (round.status === "WINNER" || round.status === "RESULT" || round.status === "FINISHED") {
        winnerBox.classList.remove("hidden");
        winnerBox.textContent = "🏆 This round has finished or has a winner.";
    } else {
        winnerBox.classList.add("hidden");
    }
}

async function pollGame() {
    if (!currentGameRoundId) return;
    try {
        const data = await api(`/api/bingo/rounds/${currentGameRoundId}/state`);
        const myCards = await loadMyCards(currentGameRoundId);
        renderGame(data, myCards);

        if (["FINISHED"].includes(data.status)) {
            clearInterval(gamePollTimer);
            gamePollTimer = null;
        }
    } catch (error) {
        showToast(error.message);
    }
}

async function openGame(roomId) {
    try {
        closeModal();
        const data = await api(`/api/bingo/rooms/${roomId}`);
        currentRoomData = data;
        currentGameRoundId = Number(data.round.id);

        document.getElementById("gameView").classList.remove("hidden");
        await pollGame();

        clearInterval(gamePollTimer);
        gamePollTimer = setInterval(pollGame, 3000);
    } catch (error) {
        showToast(error.message);
    }
}

function closeGame() {
    clearInterval(gamePollTimer);
    gamePollTimer = null;
    currentGameRoundId = null;
    document.getElementById("gameView").classList.add("hidden");
    loadDashboard();
}

async function loadAdmin() {
    try {
        const info = await api("/api/admin");
        const section = document.getElementById("adminSection");
        section.classList.remove("hidden");

        const title = document.getElementById("adminTitle");
        title.textContent = info.is_super_admin ? "👑 Super Admin" : "🛡️ Admin";

        document.getElementById("adminSummary").innerHTML = `
            <div class="admin-stat"><span>Commission</span><strong>${money(info.commission_percent)}%</strong></div>
            <div class="admin-stat"><span>Permissions</span><strong>${info.is_super_admin ? "ALL" : (info.grants || []).length}</strong></div>`;

        const stats = await api("/api/admin/dashboard");
        const s = stats.statistics || {};
        document.getElementById("adminStats").innerHTML = `
            <div class="admin-stat"><span>Players</span><strong>${s.users || 0}</strong></div>
            <div class="admin-stat"><span>Deposited</span><strong>${money(s.deposited)}</strong></div>
            <div class="admin-stat"><span>Withdrawn</span><strong>${money(s.withdrawn)}</strong></div>
            <div class="admin-stat"><span>Pending deposits</span><strong>${s.pending_deposits || 0}</strong></div>
            <div class="admin-stat"><span>Pending withdrawals</span><strong>${s.pending_withdrawals || 0}</strong></div>
            <div class="admin-stat"><span>Withdrawable</span><strong>${money(s.withdrawable)}</strong></div>`;

        const roomsData = await api("/api/admin/bingo-games");
        document.getElementById("adminRooms").innerHTML = (roomsData.rooms || []).map(r => `
            <div class="admin-row">
                <strong>Game #${r.id}</strong>
                <span>Bet ${money(r.bet_amount)} · Cartels ${r.max_cards}</span>
                <span>${Number(r.is_active) ? "ACTIVE" : "DISABLED"}</span>
            </div>`).join("") || `<div class="notice">No Bingo games configured.</div>`;

        const deposits = await api("/api/admin/deposits");
        document.getElementById("adminDeposits").innerHTML =
            (deposits.deposits || []).map(d => `
                <div class="admin-row">
                    <strong>#${d.id} · ${money(d.amount)}</strong>
                    <span>${d.bank_name || "Demo Bank"} · ${d.username ? "@" + d.username : d.telegram_user_id}</span>
                    <div class="admin-actions">
                        <button class="small-btn" data-action="approve-deposit" data-id="${d.id}">Approve</button>
                        <button class="small-btn danger" data-action="reject-deposit" data-id="${d.id}">Reject</button>
                    </div>
                </div>`).join("") || `<div class="notice">No pending deposits.</div>`;

        const withdrawals = await api("/api/admin/withdrawals");
        document.getElementById("adminWithdrawals").innerHTML =
            (withdrawals.withdrawals || []).map(w => `
                <div class="admin-row">
                    <strong>#${w.id} · ${money(w.amount)}</strong>
                    <span>${w.username ? "@" + w.username : w.telegram_user_id} · ${w.account_number || ""}</span>
                    <div class="admin-actions">
                        <button class="small-btn" data-action="approve-withdrawal" data-id="${w.id}">Approve</button>
                        <button class="small-btn danger" data-action="reject-withdrawal" data-id="${w.id}">Reject</button>
                    </div>
                </div>`).join("") || `<div class="notice">No pending withdrawals.</div>`;

        const settings = await api("/api/admin/settings");
        document.getElementById("adminCommission").value = settings.commission_percent;
        document.getElementById("adminPatterns").innerHTML = (settings.patterns || []).map(p => `
            <div class="admin-row pattern-row">
                <strong>${p.pattern_name}</strong>
                <button class="small-btn ${Number(p.is_enabled) ? "" : "danger"}"
                        data-action="toggle-pattern"
                        data-key="${p.pattern_key}"
                        data-enabled="${Number(p.is_enabled) ? 0 : 1}">
                    ${Number(p.is_enabled) ? "Disable" : "Enable"}
                </button>
            </div>`).join("");

        const adminList = document.getElementById("adminList");
        try {
            const admins = await api("/api/admin/admins");
            adminList.innerHTML = (admins.admins || []).map(a => `
                <div class="admin-row">
                    <strong>${a.telegram_user_id}</strong>
                    <span>${Number(a.is_active) ? "ACTIVE" : "INACTIVE"}</span>
                    <span>${(a.grants || []).join(", ") || "No grants"}</span>
                </div>`).join("") || `<div class="notice">No additional admins.</div>`;
        } catch (_) {
            adminList.innerHTML = `<div class="notice">Admin management permission is not assigned.</div>`;
        }
    } catch (error) {
        document.getElementById("adminSection").classList.add("hidden");
    }
}

async function adminAction(path, method = "POST", body = null) {
    const options = { method };
    if (body) options.body = JSON.stringify(body);
    await api(path, options);
    await loadAdmin();
    await loadDashboard();
    showToast("Admin action completed");
}

document.addEventListener("click", async event => {
    const target = event.target.closest("[data-action]");
    if (!target) return;

    try {
        const action = target.dataset.action;
        const id = target.dataset.id;
        if (action === "approve-deposit") await adminAction(`/api/admin/deposits/${id}/approve`);
        if (action === "reject-deposit") await adminAction(`/api/admin/deposits/${id}/reject`);
        if (action === "approve-withdrawal") await adminAction(`/api/admin/withdrawals/${id}/approve`);
        if (action === "reject-withdrawal") await adminAction(`/api/admin/withdrawals/${id}/reject`);
        if (action === "toggle-pattern") {
            await adminAction(`/api/admin/settings/patterns/${target.dataset.key}`, "POST", {
                enabled: target.dataset.enabled === "1"
            });
        }
    } catch (error) {
        showToast(error.message);
    }
});

async function saveCommission() {
    try {
        const value = Number(document.getElementById("adminCommission").value);
        await adminAction("/api/admin/settings/commission", "POST", { percent: value });
    } catch (error) {
        showToast(error.message);
    }
}

document.getElementById("refreshBtn").addEventListener("click", loadDashboard);
document.getElementById("closeModal").addEventListener("click", closeModal);
document.getElementById("modalBackdrop").addEventListener("click", closeModal);
document.getElementById("joinSelectedBtn").addEventListener("click", joinSelectedCards);
document.getElementById("closeGame").addEventListener("click", closeGame);
document.getElementById("saveCommission").addEventListener("click", saveCommission);
document.getElementById("adminRefresh").addEventListener("click", loadAdmin);

document.addEventListener("DOMContentLoaded", async () => {
    initTelegram();
    await loadDashboard();
    await loadAdmin();
});
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
