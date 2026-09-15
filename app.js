const API_BASE_URL = "https://bingo-backend-p3z5.onrender.com";
const tg = window.Telegram?.WebApp || null;

let rooms = [];
let currentUser = null;
let currentRoomData = null;
let currentGameRoundId = null;
let currentGameRoomId = null;
let modalPollTimer = null;
let gamePollTimer = null;
let finishTimer = null;
let joiningCardIds = new Set();
let banksCache = [];

function initTelegram() {
    if (!tg) return;
    tg.ready();
    tg.expand();
    tg.setHeaderColor?.("#070b16");
    tg.setBackgroundColor?.("#070b16");
}

function headers() {
    if (!tg?.initData) throw new Error("Open this page from the Telegram Mini App.");
    return {"Content-Type": "application/json", "X-Telegram-Init-Data": tg.initData};
}

async function api(path, options = {}) {
    let response;
    try {
        response = await fetch(API_BASE_URL + path, {...options, headers: {...headers(), ...(options.headers || {})}});
    } catch (_) {
        throw new Error("Could not reach the Bingo server. Check the Render service and internet connection.");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`);
    return data;
}

const money = value => Number(value || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
const statusLabel = status => ({WAITING:"WAITING", COUNTDOWN:"COUNTDOWN", PLAYING:"LIVE", WINNER:"WINNER", RESULT:"RESULT", FINISHED:"FINISHED"}[status] || status || "WAITING");

function showToast(message) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function renderUser(user) {
    if (!user) return;
    currentUser = user;
    document.getElementById("playerName").textContent = user.display_name || "Player";
    document.getElementById("totalBalance").textContent = money(user.balance);
    document.getElementById("mainBalance").textContent = money(user.main_balance);
    document.getElementById("bonusBalance").textContent = money(user.bonus_balance);
    document.getElementById("withdrawableBalance").textContent = money(user.withdrawable_balance);
}

async function refreshIdentity() {
    const me = await api("/api/me");
    renderUser(me.user);
    document.getElementById("adminNavBtn").classList.toggle("hidden", !me.is_admin);
    return me;
}

function setPage(pageId) {
    document.querySelectorAll(".app-page").forEach(p => p.classList.toggle("hidden", p.id !== pageId));
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.page === pageId));
    if (pageId === "gamesPage") loadDashboard();
    if (pageId === "depositPage") loadDepositPage();
    if (pageId === "withdrawPage") loadWithdrawPage();
    if (pageId === "profilePage") loadProfile();
    if (pageId === "adminPage") loadAdmin();
}

function renderRooms() {
    const container = document.getElementById("rooms");
    container.innerHTML = "";
    rooms.forEach(room => {
        const status = room.status || "WAITING";
        const players = Number(room.active_players || 0);
        const prize = Number(room.prize_pool || (room.bet_amount * players * (1 - Number(room.commission_percent || 0) / 100)));
        const card = document.createElement("article");
        card.className = "room-card clickable-room";
        card.dataset.room = room.room_id;
        card.innerHTML = `
          <div class="room-top"><div><div class="eyebrow">ROUND ${room.round_number || "—"}</div><div class="room-title">🎱 Bingo ${money(room.bet_amount)}</div></div><span class="room-status ${status.toLowerCase()}">${statusLabel(status)}</span></div>
          <div class="room-meta"><div class="meta-box"><span>Players</span><strong>${players}/${room.max_players || "—"}</strong></div><div class="meta-box"><span>Pot</span><strong>${money(room.total_pot)}</strong></div><div class="meta-box"><span>Prize</span><strong class="prize">${money(prize)}</strong></div></div>
          <div class="room-bottom"><div class="players">${room.selected_cards || 0} cartels selected</div><button class="join-btn" data-room="${room.room_id}">${status === "PLAYING" ? "WATCH" : "OPEN"}</button></div>`;
        container.appendChild(card);
    });
}

async function openRoomFromDashboard(roomId) {
    const room = rooms.find(r => Number(r.room_id) === Number(roomId));
    if (room && ["PLAYING", "WINNER", "RESULT"].includes(room.status)) return openGame(roomId);
    return openRoom(roomId);
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
        document.getElementById("error").textContent = error.message;
        document.getElementById("error").classList.remove("hidden");
    } finally {
        document.getElementById("loading").classList.add("hidden");
    }
}

function renderCardGrid(card, calledNumbers = []) {
    let grid = card.card_data;
    if (typeof grid === "string") { try { grid = JSON.parse(grid); } catch (_) { grid = []; } }
    const called = new Set(calledNumbers.map(Number));
    const el = document.createElement("div");
    el.className = "game-card";
    el.innerHTML = `<div class="game-card-title"><strong>Cartel #${card.card_number}</strong><span>IN PLAY</span></div>`;
    const bingoGrid = document.createElement("div");
    bingoGrid.className = "bingo-grid game-grid";
    ["B","I","N","G","O"].forEach(letter => { const h=document.createElement("div"); h.className="bingo-head"; h.textContent=letter; bingoGrid.appendChild(h); });
    for (let row=0; row<5; row++) for (let col=0; col<5; col++) {
        const cell=document.createElement("div"); cell.className="bingo-cell";
        const value=grid?.[row]?.[col] ?? "—";
        if (Number(value)===0) { cell.textContent="FREE"; cell.classList.add("free","marked"); }
        else { cell.textContent=value; if (called.has(Number(value))) cell.classList.add("marked"); }
        bingoGrid.appendChild(cell);
    }
    el.appendChild(bingoGrid); return el;
}

function createCartelButton(card, selectable) {
    const button=document.createElement("button");
    button.type="button"; button.className="card-number"; button.textContent=`Cartel ${card.card_number}`;
    button.disabled=!selectable || joiningCardIds.has(Number(card.id));
    button.addEventListener("click", () => joinCardImmediately(Number(card.id), button));
    return button;
}

function renderCardSelection(data) {
    currentRoomData=data;
    const round=data.round || {}, room=data.room || {}, players=data.players || [], available=data.available_cards || [], mine=data.my_cards || [];
    const uniquePlayers = new Set(players.map(p => Number(p.user_id))).size;
    const isOpen=["WAITING","COUNTDOWN"].includes(round.status);
    document.getElementById("modalEyebrow").textContent=`ROUND ${round.round_number || "—"} · ${statusLabel(round.status)}`;
    document.getElementById("modalTitle").textContent=`Choose a Cartel · Bingo ${money(room.bet_amount)}`;
    const countdownText = round.status === "COUNTDOWN" ? `${Number(data.countdown_remaining || 0)}s` : "Waiting";
    document.getElementById("roomSummary").innerHTML=`<div class="summary-item"><span>Players</span><strong>${uniquePlayers}/${room.max_players || "—"}</strong></div><div class="summary-item"><span>Pot</span><strong>${money(round.total_pot)}</strong></div><div class="summary-item"><span>Prize</span><strong>${money(round.prize_pool)}</strong></div><div class="summary-item"><span>Starts in</span><strong>${countdownText}</strong></div>`;

    const notice=document.getElementById("spectatorNotice");
    if (!isOpen) { notice.textContent="This round is already running. Opening the live Bingo calling screen…"; notice.classList.remove("hidden"); }
    else notice.classList.add("hidden");

    const mineSection=document.getElementById("myCardsSection"), mineGrid=document.getElementById("myCards"); mineGrid.innerHTML="";
    mineSection.classList.toggle("hidden", !mine.length);
    mine.forEach(card => { const b=document.createElement("button"); b.className="card-number locked"; b.disabled=true; b.textContent=`Cartel ${card.card_number} ✓`; mineGrid.appendChild(b); });

    const grid=document.getElementById("cardsGrid"); grid.innerHTML="";
    if (!available.length) grid.innerHTML='<div class="notice">No cartels are currently available.</div>';
    else available.forEach(card => grid.appendChild(createCartelButton(card, isOpen)));

    if (round.status === "PLAYING") openGame(Number(room.id));
}

async function openRoom(roomId) {
    try {
        closeGame(false);
        const data=await api(`/api/bingo/rooms/${roomId}`);
        renderCardSelection(data);
        document.getElementById("roomModal").classList.remove("hidden");
        clearInterval(modalPollTimer); modalPollTimer=setInterval(refreshOpenRoom, 1000);
    } catch (error) { showToast(error.message); }
}

async function refreshOpenRoom() {
    if (!currentRoomData) return;
    try {
        const roomId=Number(currentRoomData.room.id), data=await api(`/api/bingo/rooms/${roomId}`);
        renderUser(data.user); renderCardSelection(data);
    } catch (error) { showToast(error.message); }
}

async function joinCardImmediately(cardId, button) {
    if (!currentRoomData || joiningCardIds.has(cardId)) return;
    const roomId=Number(currentRoomData.room.id);
    joiningCardIds.add(cardId); button.disabled=true; button.textContent="Joining…";
    try {
        const result=await api(`/api/bingo/rooms/${roomId}/join`, {method:"POST", body:JSON.stringify({card_id:cardId})});
        renderUser(result.user || currentUser);
        showToast("Cartel joined. You can select another until countdown ends.");
        await refreshOpenRoom();
    } catch (error) { showToast(error.message); await refreshOpenRoom(); }
    finally { joiningCardIds.delete(cardId); }
}

function closeModal() {
    clearInterval(modalPollTimer); modalPollTimer=null; currentRoomData=null;
    document.getElementById("roomModal").classList.add("hidden");
}

async function loadMyCards(roundId) { const data=await api(`/api/bingo/rounds/${roundId}/my-cards`); return data.cards || []; }

function renderGame(data, myCards) {
    const round=data.round || {}, room=currentRoomData?.room || {};
    document.getElementById("gameTitle").textContent=`Bingo ${money(room.bet_amount)}`;
    document.getElementById("gameStatus").textContent=statusLabel(round.status);
    const called=data.called_numbers || [];
    document.getElementById("lastCalled").textContent=data.last_called ?? "—";
    document.getElementById("calledCount").textContent=called.length;
    document.getElementById("calledNumbers").innerHTML=called.map(n=>`<span>${n}</span>`).join("");
    document.getElementById("gamePlayers").textContent=new Set((data.players || []).map(p => Number(p.user_id))).size;
    document.getElementById("gamePrize").textContent=money(data.financials?.prize_pool ?? round.prize_pool ?? 0);
    document.getElementById("gameCountdown").textContent=round.status === "COUNTDOWN" ? `${Number(data.countdown_remaining || 0)}s` : (round.status === "PLAYING" ? "LIVE" : "—");

    const cards=document.getElementById("gameCards"); cards.innerHTML="";
    if (myCards.length) myCards.forEach(card=>cards.appendChild(renderCardGrid(card,called)));
    else cards.innerHTML='<div class="notice">👀 Spectator mode. You can watch every called number. Cartels can be selected when this round ends.</div>';

    const winner=document.getElementById("winnerNotice");
    if (["WINNER","RESULT","FINISHED"].includes(round.status)) {
        winner.classList.remove("hidden"); winner.textContent="🏆 Winner released. Returning to cartel selection in 3 seconds…";
        scheduleReturnToSelection();
    } else winner.classList.add("hidden");
}

async function pollGame() {
    if (!currentGameRoundId) return;
    try {
        const data=await api(`/api/bingo/rounds/${currentGameRoundId}/state`);
        const cards=await loadMyCards(currentGameRoundId);
        renderUser(data.user); renderGame(data,cards);
    } catch (error) { showToast(error.message); }
}

async function openGame(roomId) {
    try {
        closeModal();
        const data=await api(`/api/bingo/rooms/${roomId}`);
        currentRoomData=data; currentGameRoundId=Number(data.round.id); currentGameRoomId=Number(roomId);
        document.getElementById("gameView").classList.remove("hidden");
        await pollGame();
        clearInterval(gamePollTimer); gamePollTimer=setInterval(pollGame, 1000);
    } catch (error) { showToast(error.message); }
}

function scheduleReturnToSelection() {
    if (finishTimer) return;
    clearInterval(gamePollTimer); gamePollTimer=null;
    finishTimer=setTimeout(async () => {
        finishTimer=null;
        const roomId=currentGameRoomId;
        closeGame(false);
        await loadDashboard();
        if (roomId) await openRoom(roomId);
    }, 3000);
}

function closeGame(goDashboard=true) {
    clearInterval(gamePollTimer); gamePollTimer=null; clearTimeout(finishTimer); finishTimer=null;
    currentGameRoundId=null; currentGameRoomId=null; document.getElementById("gameView").classList.add("hidden");
    if (goDashboard) loadDashboard();
}

async function loadBanks() {
    if (banksCache.length) return banksCache;
    const data=await api("/api/wallet/banks"); banksCache=data.banks || []; return banksCache;
}
function fillBankSelect(id,banks) { document.getElementById(id).innerHTML=banks.map(b=>`<option value="${b.id}">${b.bank_name} · ${b.account_number}</option>`).join(""); }
function historyHtml(items, type) { return items.length ? items.map(x=>`<div class="history-row"><strong>${type} #${x.id} · ${money(x.amount)}</strong><span>${x.status}</span><small>${x.created_at || ""}</small></div>`).join("") : '<div class="notice">No requests yet.</div>'; }

async function loadDepositPage() {
    try { const banks=await loadBanks(); fillBankSelect("depositBank",banks); const d=await api("/api/deposits"); document.getElementById("depositHistory").innerHTML=historyHtml(d.deposits || [],"Deposit"); } catch(e){ showToast(e.message); }
}
async function submitDeposit() {
    try { await api("/api/deposits",{method:"POST",body:JSON.stringify({bank_id:Number(document.getElementById("depositBank").value),amount:Number(document.getElementById("depositAmount").value),transaction_id:document.getElementById("depositTransaction").value.trim()})}); showToast("Deposit request submitted"); document.getElementById("depositAmount").value=""; document.getElementById("depositTransaction").value=""; await loadDepositPage(); } catch(e){ showToast(e.message); }
}
async function loadWithdrawPage() {
    try { const banks=await loadBanks(); fillBankSelect("withdrawBank",banks); const d=await api("/api/withdrawals"); document.getElementById("withdrawHistory").innerHTML=historyHtml(d.withdrawals || [],"Withdrawal"); } catch(e){ showToast(e.message); }
}
async function submitWithdrawal() {
    try { await api("/api/withdrawals",{method:"POST",body:JSON.stringify({bank_id:Number(document.getElementById("withdrawBank").value),account_number:document.getElementById("withdrawAccount").value.trim(),account_name:document.getElementById("withdrawName").value.trim(),amount:Number(document.getElementById("withdrawAmount").value)})}); showToast("Withdrawal request submitted"); await loadWithdrawPage(); await refreshIdentity(); } catch(e){ showToast(e.message); }
}
async function loadProfile() {
    try { const d=await api("/api/profile"), p=d.profile || {}; renderUser(d.user); document.getElementById("profileCard").innerHTML=`<div><span>Telegram ID</span><strong>${p.telegram_user_id || "—"}</strong></div><div><span>Username</span><strong>${p.username ? "@"+p.username : "—"}</strong></div><div><span>Name</span><strong>${[p.first_name,p.last_name].filter(Boolean).join(" ") || "—"}</strong></div><div><span>Phone</span><strong>${p.phone_number || "—"}</strong></div><div><span>Referral code</span><strong>${p.referral_code || "—"}</strong></div><div><span>Total deposited</span><strong>${money(p.total_deposited)}</strong></div><div><span>Total withdrawn</span><strong>${money(p.total_withdrawn)}</strong></div><div><span>Total won</span><strong>${money(p.total_won)}</strong></div><div><span>Registered</span><strong>${p.registered_at || "—"}</strong></div>`; } catch(e){ showToast(e.message); }
}

async function safePanel(path, renderer, elementId) {
    try { const d=await api(path); renderer(d); } catch(e){ const el=document.getElementById(elementId); if(el) el.innerHTML=`<div class="notice">${e.message}</div>`; }
}
async function loadAdmin() {
    try {
        const info=await api("/api/admin"); document.getElementById("adminSection").classList.remove("hidden");
        document.getElementById("adminTitle").textContent=info.is_super_admin?"👑 Super Admin":"🛡️ Admin";
        document.getElementById("adminSummary").innerHTML=`<div class="admin-stat"><span>Commission</span><strong>${money(info.commission_percent)}%</strong></div><div class="admin-stat"><span>Permissions</span><strong>${info.is_super_admin?"ALL":(info.grants||[]).length}</strong></div>`;
        await Promise.all([
            safePanel("/api/admin/dashboard", d=>{const s=d.statistics||{}; document.getElementById("adminStats").innerHTML=`<div class="admin-stat"><span>Players</span><strong>${s.users||0}</strong></div><div class="admin-stat"><span>Deposited</span><strong>${money(s.deposited)}</strong></div><div class="admin-stat"><span>Withdrawn</span><strong>${money(s.withdrawn)}</strong></div><div class="admin-stat"><span>Pending deposits</span><strong>${s.pending_deposits||0}</strong></div><div class="admin-stat"><span>Pending withdrawals</span><strong>${s.pending_withdrawals||0}</strong></div>`;},"adminStats"),
            safePanel("/api/admin/bingo-games", d=>{document.getElementById("adminRooms").innerHTML=(d.rooms||[]).map(r=>`<div class="admin-row"><strong>Game #${r.id}</strong><span>Bet ${money(r.bet_amount)} · Cartels ${r.max_cards}</span></div>`).join("")||'<div class="notice">No games.</div>';},"adminRooms"),
            safePanel("/api/admin/deposits", d=>{document.getElementById("adminDeposits").innerHTML=(d.deposits||[]).map(x=>`<div class="admin-row"><strong>#${x.id} · ${money(x.amount)}</strong><span>${x.username?"@"+x.username:x.telegram_user_id}</span><div class="admin-actions"><button class="small-btn" data-action="approve-deposit" data-id="${x.id}">Approve</button><button class="small-btn danger" data-action="reject-deposit" data-id="${x.id}">Reject</button></div></div>`).join("")||'<div class="notice">No pending deposits.</div>';},"adminDeposits"),
            safePanel("/api/admin/withdrawals", d=>{document.getElementById("adminWithdrawals").innerHTML=(d.withdrawals||[]).map(x=>`<div class="admin-row"><strong>#${x.id} · ${money(x.amount)}</strong><span>${x.username?"@"+x.username:x.telegram_user_id}</span><div class="admin-actions"><button class="small-btn" data-action="approve-withdrawal" data-id="${x.id}">Approve</button><button class="small-btn danger" data-action="reject-withdrawal" data-id="${x.id}">Reject</button></div></div>`).join("")||'<div class="notice">No pending withdrawals.</div>';},"adminWithdrawals"),
            safePanel("/api/admin/settings", d=>{document.getElementById("adminCommission").value=d.commission_percent; document.getElementById("adminPatterns").innerHTML=(d.patterns||[]).map(p=>`<div class="admin-row"><strong>${p.pattern_name}</strong><button class="small-btn ${Number(p.is_enabled)?"":"danger"}" data-action="toggle-pattern" data-key="${p.pattern_key}" data-enabled="${Number(p.is_enabled)?0:1}">${Number(p.is_enabled)?"Disable":"Enable"}</button></div>`).join("");},"adminPatterns"),
            safePanel("/api/admin/admins", d=>{document.getElementById("adminList").innerHTML=(d.admins||[]).map(a=>`<div class="admin-row"><strong>${a.telegram_user_id}</strong><span>${Number(a.is_active)?"ACTIVE":"INACTIVE"}</span><span>${(a.grants||[]).join(", ")||"No grants"}</span></div>`).join("")||'<div class="notice">No additional admins.</div>';},"adminList")
        ]);
    } catch(e) { document.getElementById("adminSection").classList.add("hidden"); showToast(e.message); }
}
async function adminAction(path, body=null) { const options={method:"POST"}; if(body) options.body=JSON.stringify(body); await api(path,options); showToast("Admin action completed"); await loadAdmin(); await loadDashboard(); }
async function saveCommission(){ try{await adminAction("/api/admin/settings/commission",{percent:Number(document.getElementById("adminCommission").value)});}catch(e){showToast(e.message);} }
async function downloadBackup(){ try{const r=await fetch(API_BASE_URL+"/api/admin/database-backup",{headers:{"X-Telegram-Init-Data":tg.initData}}); if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.detail||"Backup failed");} const blob=await r.blob(); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download="bingo-backup.db"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000); showToast("Database backup ready");}catch(e){showToast(e.message);} }

document.addEventListener("click", async e => {
    const nav=e.target.closest(".nav-btn"); if(nav){setPage(nav.dataset.page); return;}
    const room=e.target.closest(".clickable-room"); if(room && !e.target.closest("[data-action]")){openRoomFromDashboard(Number(room.dataset.room)); return;}
    const a=e.target.closest("[data-action]"); if(!a) return;
    try { if(a.dataset.action==="approve-deposit") await adminAction(`/api/admin/deposits/${a.dataset.id}/approve`); if(a.dataset.action==="reject-deposit") await adminAction(`/api/admin/deposits/${a.dataset.id}/reject`); if(a.dataset.action==="approve-withdrawal") await adminAction(`/api/admin/withdrawals/${a.dataset.id}/approve`); if(a.dataset.action==="reject-withdrawal") await adminAction(`/api/admin/withdrawals/${a.dataset.id}/reject`); if(a.dataset.action==="toggle-pattern") await adminAction(`/api/admin/settings/patterns/${a.dataset.key}`,{enabled:a.dataset.enabled==="1"}); } catch(err){showToast(err.message);}
});

document.getElementById("refreshBtn").addEventListener("click",()=>setPage(document.querySelector(".nav-btn.active")?.dataset.page || "gamesPage"));
document.getElementById("closeModal").addEventListener("click",closeModal);
document.getElementById("modalBackdrop").addEventListener("click",closeModal);
document.getElementById("closeGame").addEventListener("click",()=>closeGame(true));
document.getElementById("submitDeposit").addEventListener("click",submitDeposit);
document.getElementById("submitWithdrawal").addEventListener("click",submitWithdrawal);
document.getElementById("adminRefresh").addEventListener("click",loadAdmin);
document.getElementById("saveCommission").addEventListener("click",saveCommission);
document.getElementById("downloadBackup").addEventListener("click",downloadBackup);

document.addEventListener("DOMContentLoaded", async () => {
    initTelegram();
    try { await refreshIdentity(); await loadDashboard(); }
    catch(e){ document.getElementById("error").textContent=e.message; document.getElementById("error").classList.remove("hidden"); }
});
