const API_BASE_URL = "https://bingo-backend-p3z5.onrender.com";
const tg = window.Telegram?.WebApp || null;

let rooms = [];
let currentUser = null;
let currentRoomData = null;
let currentGameRoundId = null;
let currentGameRoomId = null;
let dashboardPollTimer = null;
let selectionPollTimer = null;
let gamePollTimer = null;
let banksCache = [];
let resumeHandled = false;
let gamePollInFlight = false;
let dashboardPollInFlight = false;
let selectionPollInFlight = false;

function initTelegram() {
    if (!tg) return;
    tg.ready();
    tg.expand();
    tg.setHeaderColor?.("#070b16");
    tg.setBackgroundColor?.("#070b16");
}

function headers() {
    if (!tg?.initData) throw new Error("Open this page from the Telegram Mini App.");
    return {"Content-Type":"application/json", "X-Telegram-Init-Data":tg.initData};
}

async function api(path, options = {}) {
    const requestOptions={...options, headers:{...headers(), ...(options.headers || {})}};
    let lastError=null;
    for(let attempt=0; attempt<2; attempt++){
        try {
            const response=await fetch(API_BASE_URL + path,requestOptions);
            const data=await response.json().catch(()=>({}));
            if(!response.ok){
                const message=data.detail || `Request failed (${response.status})`;
                // Retry only transient gateway/service failures. A 500 from the
                // application should be shown as a real backend error, not called
                // a network error.
                if([502,503,504].includes(response.status) && attempt===0){
                    await new Promise(r=>setTimeout(r,700));
                    continue;
                }
                throw new Error(message);
            }
            return data;
        } catch(error) {
            lastError=error;
            if(error instanceof TypeError && attempt===0){
                await new Promise(r=>setTimeout(r,700));
                continue;
            }
            throw error;
        }
    }
    throw lastError || new Error("Could not reach the Bingo server.");
}

const money = value => Number(value || 0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const statusLabel = status => ({WAITING:"WAITING",COUNTDOWN:"COUNTDOWN",PLAYING:"LIVE",WINNER:"WINNER",RESULT:"RESULT",FINISHED:"FINISHED"}[status] || status || "WAITING");

function showToast(message) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function showAppError(message) {
    const el = document.getElementById("error");
    if (el) {
        el.textContent = message || "Something went wrong.";
        el.classList.remove("hidden");
    }
}

function ensureCallingStyles() {
    if (document.getElementById("bingoCallingRuntimeStyles")) return;
    const style = document.createElement("style");
    style.id = "bingoCallingRuntimeStyles";
    style.textContent = `
        #calledNumbers.calling-board { display:flex; flex-direction:column; width:100%; overflow:hidden; padding:4px 0 10px; }
        .calling-number-row { display:grid; grid-template-columns:22px repeat(15,minmax(0,1fr)); gap:2px; width:100%; margin:3px 0; }
        .calling-letter { min-width:0; height:28px; border-radius:7px; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:12px; background:rgba(255,255,255,.10); }
        .calling-number { min-width:0; height:28px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:800; background:rgba(255,255,255,.055); border:1px solid rgba(255,255,255,.09); }
        .calling-number.called { background:rgba(255,255,255,.24); border-color:rgba(255,255,255,.48); box-shadow:0 0 0 2px rgba(255,255,255,.08) inset; }
        .calling-letter.b { background:rgba(42,127,255,.28); color:#8ec5ff; }
        .calling-letter.i { background:rgba(43,180,99,.28); color:#8ff0b8; }
        .calling-letter.n { background:rgba(238,177,55,.28); color:#ffd87d; }
        .calling-letter.g { background:rgba(232,87,87,.28); color:#ffaaaA; }
        .calling-letter.o { background:rgba(164,91,232,.28); color:#d7adff; }
        #gameCards .player-cartel-group { margin:12px 0 18px; }
        #gameCards .player-cartel-name { font-weight:800; margin-bottom:8px; }
        #gameErrorNotice { margin:10px 0; padding:12px 14px; border-radius:12px; background:rgba(220,60,60,.14); border:1px solid rgba(255,100,100,.35); color:#ffb4b4; font-size:13px; line-height:1.4; }
    `;
    document.head.appendChild(style);
}

function bingoLetterForNumber(number) {
    const n=Number(number);
    if(n>=1 && n<=15) return "B";
    if(n>=16 && n<=30) return "I";
    if(n>=31 && n<=45) return "N";
    if(n>=46 && n<=60) return "G";
    if(n>=61 && n<=75) return "O";
    return "";
}

function formatCalledNumber(number) {
    const n=Number(number);
    return n ? `${bingoLetterForNumber(n)} ${n}` : "—";
}

function showCallingError(message) {
    ensureCallingStyles();
    let el = document.getElementById("gameErrorNotice");
    const parent = document.getElementById("winnerNotice")?.parentElement || document.getElementById("callingPage");
    if (!el) {
        el = document.createElement("div");
        el.id = "gameErrorNotice";
        parent.insertBefore(el, document.getElementById("winnerNotice") || parent.firstChild);
    }
    el.textContent = message || "Could not reach the Bingo server.";
    el.classList.remove("hidden");
}

function clearCallingError() {
    const el = document.getElementById("gameErrorNotice");
    if (el) { el.textContent = ""; el.classList.add("hidden"); }
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

function stopDashboardPolling() { clearInterval(dashboardPollTimer); dashboardPollTimer = null; }
function stopSelectionPolling() { clearInterval(selectionPollTimer); selectionPollTimer = null; }
function stopGamePolling() { clearInterval(gamePollTimer); gamePollTimer = null; }

function setPage(pageId) {
    document.querySelectorAll(".app-page").forEach(p => p.classList.toggle("hidden", p.id !== pageId));
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.page === pageId));

    if (pageId !== "dashboardPage") stopDashboardPolling();
    if (pageId !== "cartelPage") stopSelectionPolling();
    if (pageId !== "callingPage") stopGamePolling();

    if (pageId === "dashboardPage") startDashboardPolling();
    if (pageId === "depositPage") loadDepositPage();
    if (pageId === "withdrawPage") loadWithdrawPage();
    if (pageId === "profilePage") loadProfile();
    if (pageId === "adminPage") loadAdmin();
}

function startDashboardPolling() {
    loadDashboard();
    stopDashboardPolling();
    dashboardPollTimer = setInterval(loadDashboard, 1000);
}

function renderRooms() {
    const container = document.getElementById("rooms");
    container.innerHTML = "";
    if (!rooms.length) {
        container.innerHTML = '<div class="notice">No Bingo games are currently available.</div>';
        return;
    }

    rooms.forEach(room => {
        const status = room.status || "WAITING";
        const players = Number(room.active_players || 0);
        const countdown = status === "COUNTDOWN" ? `${Number(room.countdown_remaining || 0)}s` : "—";
        const prize = Number(room.prize_pool || 0);
        const card = document.createElement("article");
        card.className = "room-card clickable-room";
        card.dataset.room = room.room_id;
        card.innerHTML = `
            <div class="room-top">
                <div><div class="eyebrow">ROUND ${room.round_number || "—"}</div><div class="room-title">🎱 Bingo ${money(room.bet_amount)}</div></div>
                <span class="room-status ${status.toLowerCase()}">${statusLabel(status)}</span>
            </div>
            <div class="room-meta">
                <div class="meta-box"><span>Players</span><strong>${players}/${room.max_players || "—"}</strong></div>
                <div class="meta-box"><span>Prize</span><strong class="prize">${money(prize)}</strong></div>
                <div class="meta-box"><span>Starts in</span><strong class="countdown-number">${countdown}</strong></div>
            </div>
            <div class="room-bottom"><div class="players">${room.selected_cards || 0} cartels selected</div><button class="join-btn">${["PLAYING","WINNER","RESULT"].includes(status) ? "WATCH" : "SELECT CARTEL"}</button></div>`;
        container.appendChild(card);
    });
}

async function loadDashboard() {
    if(dashboardPollInFlight) return;
    dashboardPollInFlight=true;
    try {
        const data = await api("/api/bingo/dashboard");
        renderUser(data.user);
        rooms = data.rooms || [];
        renderRooms();

        if (!resumeHandled && data.resume) {
            resumeHandled = true;
            const status = data.resume.status;
            if (["PLAYING","WINNER","RESULT"].includes(status)) {
                await openCallingPage(Number(data.resume.room_id));
            } else if (["WAITING","COUNTDOWN"].includes(status)) {
                await openCartelPage(Number(data.resume.room_id));
            }
        }
        document.getElementById("loading").classList.add("hidden");
        document.getElementById("error").classList.add("hidden");
    } catch (error) {
        document.getElementById("loading").classList.add("hidden");
        document.getElementById("error").textContent = error.message;
        document.getElementById("error").classList.remove("hidden");
    } finally {
        dashboardPollInFlight=false;
    }
}

function renderCartelButton(card, selectable) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "card-number";
    button.textContent = `Cartel ${card.card_number}`;
    button.disabled = !selectable;
    if (!selectable) button.classList.add("locked");
    button.addEventListener("click", () => joinCardImmediately(Number(card.id), button));
    return button;
}

function renderMiniCard(card, calledNumbers = [], winningPattern = null) {
    let grid = card.card_data;
    if (typeof grid === "string") { try { grid = JSON.parse(grid); } catch (_) { grid = []; } }
    const called = new Set((calledNumbers || []).map(Number));
    const el = document.createElement("div");
    el.className = "game-card";
    el.innerHTML = `<div class="game-card-title"><strong>Cartel #${card.card_number}</strong><span>IN PLAY</span></div>`;
    const bingoGrid = document.createElement("div");
    bingoGrid.className = "bingo-grid game-grid";
    ["B","I","N","G","O"].forEach(letter => { const h=document.createElement("div"); h.className="bingo-head"; h.textContent=letter; bingoGrid.appendChild(h); });
    const marks = getWinningCells(grid, winningPattern);
    for (let row=0; row<5; row++) for (let col=0; col<5; col++) {
        const cell=document.createElement("div"); cell.className="bingo-cell";
        const value=grid?.[row]?.[col] ?? "—";
        if (Number(value)===0) { cell.textContent="FREE"; cell.classList.add("free","marked"); }
        else {
            cell.textContent=value;
            if (called.has(Number(value))) cell.classList.add("marked");
            if (marks.has(`${row}:${col}`)) cell.classList.add("winning-cell");
        }
        bingoGrid.appendChild(cell);
    }
    el.appendChild(bingoGrid);
    return el;
}

function getWinningCells(grid, pattern) {
    const cells = new Set();
    const key = String(pattern || "").toUpperCase();
    if (!grid || !key) return cells;
    if (key === "HORIZONTAL") {
        for (let r=0;r<5;r++) for(let c=0;c<5;c++) cells.add(`${r}:${c}`);
    } else if (key === "VERTICAL") {
        for (let c=0;c<5;c++) for(let r=0;r<5;r++) cells.add(`${r}:${c}`);
    } else if (key === "DIAGONAL") {
        for(let i=0;i<5;i++){cells.add(`${i}:${i}`);cells.add(`${i}:${4-i}`);}
    } else if (key === "FOUR_CORNERS") {
        [[0,0],[0,4],[4,0],[4,4]].forEach(([r,c])=>cells.add(`${r}:${c}`));
    } else if (key === "X") {
        for(let i=0;i<5;i++){cells.add(`${i}:${i}`);cells.add(`${i}:${4-i}`);}
    } else if (key === "PLUS") {
        for(let i=0;i<5;i++){cells.add(`2:${i}`);cells.add(`${i}:2`);}
    } else if (key === "FULL_HOUSE" || key === "BLACKOUT") {
        for(let r=0;r<5;r++) for(let c=0;c<5;c++) cells.add(`${r}:${c}`);
    }
    return cells;
}

function renderMyCartelDetails(cards, calledNumbers = []) {
    const section = document.getElementById("myCardsSection");
    const target = document.getElementById("myCardsDetails");
    target.innerHTML = "";
    section.classList.toggle("hidden", !cards.length);
    cards.forEach(card => target.appendChild(renderMiniCard(card, calledNumbers)));
}

function renderCartelSelection(data) {
    currentRoomData = data;
    const round=data.round || {}, room=data.room || {}, players=data.players || [], available=data.available_cards || [], mine=data.my_cards || [];
    const uniquePlayers=new Set(players.map(p=>Number(p.user_id))).size;
    const open=["WAITING","COUNTDOWN"].includes(round.status);
    const countdown=round.status === "COUNTDOWN" ? `${Number(data.countdown_remaining || 0)}s` : "—";

    document.getElementById("cartelEyebrow").textContent=`ROUND ${round.round_number || "—"} · ${statusLabel(round.status)}`;
    document.getElementById("cartelTitle").textContent=`Bingo ${money(room.bet_amount)} · Cartel Selection`;
    document.getElementById("cartelStatus").textContent=statusLabel(round.status);
    document.getElementById("cartelStatus").className=`room-status ${String(round.status || "WAITING").toLowerCase()}`;
    document.getElementById("cartelSummary").innerHTML=`
        <div class="summary-item"><span>Players</span><strong>${uniquePlayers}/${room.max_players || "—"}</strong></div>
        <div class="summary-item"><span>Cartels</span><strong>${Number(room.selected_cards || data.selected_cards || mine.length || 0)}</strong></div>
        <div class="summary-item"><span>Prize</span><strong class="prize">${money(round.prize_pool)}</strong></div>
        <div class="summary-item"><span>Starts in</span><strong>${countdown}</strong></div>`;
    document.getElementById("selectedCount").textContent=mine.length;
    document.getElementById("cartelCountdown").textContent=countdown;

    const notice=document.getElementById("cartelNotice");
    if (!open) { notice.textContent="This round is already running. You are viewing the live Bingo calling page."; notice.classList.remove("hidden"); }
    else notice.classList.add("hidden");

    const grid=document.getElementById("cardsGrid"); grid.innerHTML="";
    if (!available.length) grid.innerHTML='<div class="notice">No cartels are currently available.</div>';
    else available.forEach(card=>grid.appendChild(renderCartelButton(card,open)));
    renderMyCartelDetails(mine);

}

async function openCartelPage(roomId) {
    stopDashboardPolling();
    stopGamePolling();
    stopSelectionPolling();
    setPage("cartelPage");
    try {
        const data=await api(`/api/bingo/rooms/${roomId}`);
        data.my_cards=await loadMyCards(Number(data.round.id));
        currentRoomData=data;
        renderUser(data.user);

        if (["PLAYING","WINNER","RESULT"].includes(data.round.status)) {
            await openCallingPage(Number(roomId));
            return;
        }

        renderCartelSelection(data);
        selectionPollTimer=setInterval(refreshCartelPage,1000);
    } catch(error) {
        showAppError(`Bingo game error: ${error.message}`);
        showToast(error.message);
        setPage("dashboardPage");
    }
}

async function refreshCartelPage() {
    if (!currentRoomData || selectionPollInFlight) return;
    selectionPollInFlight=true;
    try {
        const roomId=Number(currentRoomData.room.id);
        const data=await api(`/api/bingo/rooms/${roomId}`);
        data.my_cards=await loadMyCards(Number(data.round.id));
        renderUser(data.user);

        if (["PLAYING","WINNER","RESULT"].includes(data.round.status)) {
            await openCallingPage(roomId);
            return;
        }

        currentRoomData=data;
        renderCartelSelection(data);
    } catch(error) {
        showAppError(`Bingo game error: ${error.message}`);
        showToast(error.message);
    } finally {
        selectionPollInFlight=false;
    }
}

async function joinCardImmediately(cardId, button) {
    if (!currentRoomData) return;
    const roomId=Number(currentRoomData.room.id);
    button.disabled=true; button.textContent="Joining…";
    try {
        const result=await api(`/api/bingo/rooms/${roomId}/join`,{method:"POST",body:JSON.stringify({card_id:cardId})});
        renderUser(result.user || currentUser);
        showToast("Cartel joined. You can select another until the countdown ends.");
        await refreshCartelPage();
    } catch(error) {
        showToast(error.message);
        showAppError(`Cartel selection error: ${error.message}`);
        await refreshCartelPage();
    }
}

async function openCallingPage(roomId) {
    stopDashboardPolling();
    stopSelectionPolling();
    stopGamePolling();
    setPage("callingPage");
    ensureCallingStyles();
    clearCallingError();
    try {
        const roomData=await api(`/api/bingo/rooms/${roomId}`);
        currentRoomData=roomData;
        currentGameRoomId=Number(roomId);
        currentGameRoundId=Number(roomData.round.id);
        renderUser(roomData.user);
        await pollGame();
        gamePollTimer=setInterval(pollGame,1000);
    } catch(error) {
        showAppError(`Bingo game error: ${error.message}`);
        showToast(error.message);
        setPage("dashboardPage");
    }
}

async function loadMyCards(roundId) {
    const data=await api(`/api/bingo/rounds/${roundId}/my-cards`);
    return data.cards || [];
}

function renderWinnerPanel(data, myCards) {
    const panel=document.getElementById("winnerNotice");
    const winners=data.winners || [];
    if (!winners.length || !["WINNER","RESULT","FINISHED"].includes(data.status)) {
        panel.classList.add("hidden");
        return;
    }
    panel.classList.remove("hidden");
    const ownId=Number(currentUser?.telegram_user_id || 0);
    const own=winners.filter(w=>Number(w.telegram_user_id)===ownId);
    let html='<div class="winner-title">🏆 WINNER</div>';
    if (own.length) {
        own.forEach(w=>{
            const card=myCards.find(c=>Number(c.card_number)===Number(w.card_number));
            html += `<div class="winner-own"><strong>🎉 YOU WON!</strong><p>Cartel #${w.card_number} · ${w.pattern_name || w.pattern}</p><p>Prize: <strong>${money(w.prize_amount)}</strong></p><p class="winner-explain">You completed the <strong>${w.pattern_name || w.pattern}</strong> pattern with the called numbers. Your winning cells are highlighted below.</p></div>`;
            if (card) card._winningPattern=w.pattern;
        });
    }
    html += '<div class="winner-list"><strong>All winners</strong>' + winners.map(w=>`<div class="winner-row"><span>Cartel #${w.card_number}</span><span>${w.first_name || w.username || "Player"}</span><span>${w.pattern_name || w.pattern}</span><span>${money(w.prize_amount)}</span></div>`).join("") + '</div>';
    panel.innerHTML=html;
}

function renderCallingBoard(calledNumbers) {
    ensureCallingStyles();
    const container=document.getElementById("calledNumbers");
    container.className="called-numbers calling-board";
    const called=new Set((calledNumbers || []).map(Number));
    const groups=[
        ["B",1,15],
        ["I",16,30],
        ["N",31,45],
        ["G",46,60],
        ["O",61,75]
    ];
    container.innerHTML=groups.map(([letter,start,end])=>{
        const key=letter.toLowerCase();
        let html=`<div class="calling-number-row"><div class="calling-letter ${key}">${letter}</div>`;
        for(let n=start;n<=end;n++) html+=`<div class="calling-number ${called.has(n)?"called":""}">${n}</div>`;
        return html+"</div>";
    }).join("");
}

function renderPlayerCartels(myCards, calledNumbers, winners) {
    const cards=document.getElementById("gameCards");
    cards.innerHTML="";
    const winnerMap=new Map((winners || []).map(w=>[Number(w.card_number),w]));
    if(!myCards.length){
        cards.innerHTML='<div class="notice">You have no selected cartel in this round.</div>';
        return;
    }
    myCards.forEach(myCard=>{
        const winner=winnerMap.get(Number(myCard.card_number));
        const card=renderMiniCard(myCard,calledNumbers,winner?.pattern || myCard._winningPattern || null);
        cards.appendChild(card);
    });
}

function renderCalling(data, myCards) {
    const round=data.round || {};
    const room=currentRoomData?.room || {};
    const players=data.players || [];
    const uniquePlayers=new Set(players.map(p=>Number(p.user_id))).size;
    const called=data.called_numbers || [];
    document.getElementById("gameTitle").textContent=`Bingo ${money(room.bet_amount)}`;
    document.getElementById("gameStatus").textContent=statusLabel(round.status);
    document.getElementById("gameStatus").className=`room-status ${String(round.status || "PLAYING").toLowerCase()}`;
    document.getElementById("lastCalled").textContent=formatCalledNumber(data.last_called);
    document.getElementById("calledCount").textContent=called.length;
    document.getElementById("gamePlayers").textContent=uniquePlayers;
    document.getElementById("gamePrize").textContent=money(data.financials?.prize_pool ?? round.prize_pool ?? 0);
    document.getElementById("gameCountdown").textContent=round.status === "COUNTDOWN" ? `${Number(data.countdown_remaining || 0)}s` : (round.status === "PLAYING" ? "LIVE" : "—");

    renderCallingBoard(called);
    renderWinnerPanel(data,myCards);
    renderPlayerCartels(myCards,called,data.winners || []);
}

async function pollGame() {
    if (!currentGameRoundId || gamePollInFlight) return;
    gamePollInFlight=true;
    try {
        const data=await api(`/api/bingo/rounds/${currentGameRoundId}/state`);
        const cards=await loadMyCards(currentGameRoundId);
        renderUser(data.user);
        clearCallingError();
        renderCalling(data,cards);

        if (data.status === "FINISHED") {
            stopGamePolling();
            const roomId=currentGameRoomId;
            // Keep the completed round visible long enough for EVERY player to
            // see the persisted winner information, then create/show the next round.
            renderWinnerPanel(data,cards);
            setTimeout(()=>openCartelPage(roomId),6000);
        }
    } catch(error) {
        showCallingError(error.message);
        showToast(error.message);
    } finally {
        gamePollInFlight=false;
    }
}

function closeCalling() {
    stopGamePolling();
    currentGameRoundId=null;
    currentGameRoomId=null;
    currentRoomData=null;
    setPage("dashboardPage");
}

async function loadBanks() {
    if (banksCache.length) return banksCache;
    const data=await api("/api/wallet/banks");
    banksCache=data.banks || [];
    return banksCache;
}
function fillBankSelect(id,banks) { document.getElementById(id).innerHTML=banks.map(b=>`<option value="${b.id}">${b.bank_name} · ${b.account_number}</option>`).join(""); }
function historyHtml(items,type) { return items.length ? items.map(x=>`<div class="history-row"><strong>${type} #${x.id} · ${money(x.amount)}</strong><span>${x.status}</span><small>${x.created_at || ""}</small></div>`).join("") : '<div class="notice">No requests yet.</div>'; }

async function loadDepositPage() {
    try { const banks=await loadBanks(); fillBankSelect("depositBank",banks); const d=await api("/api/deposits"); document.getElementById("depositHistory").innerHTML=historyHtml(d.deposits || [],"Deposit"); }
    catch(e){ showToast(e.message); }
}
async function submitDeposit() {
    try { await api("/api/deposits",{method:"POST",body:JSON.stringify({bank_id:Number(document.getElementById("depositBank").value),amount:Number(document.getElementById("depositAmount").value),transaction_id:document.getElementById("depositTransaction").value.trim()})}); showToast("Deposit request submitted"); document.getElementById("depositAmount").value=""; document.getElementById("depositTransaction").value=""; await loadDepositPage(); }
    catch(e){ showToast(e.message); }
}
async function loadWithdrawPage() {
    try { const banks=await loadBanks(); fillBankSelect("withdrawBank",banks); const d=await api("/api/withdrawals"); document.getElementById("withdrawHistory").innerHTML=historyHtml(d.withdrawals || [],"Withdrawal"); }
    catch(e){ showToast(e.message); }
}
async function submitWithdrawal() {
    try { await api("/api/withdrawals",{method:"POST",body:JSON.stringify({bank_id:Number(document.getElementById("withdrawBank").value),account_number:document.getElementById("withdrawAccount").value.trim(),account_name:document.getElementById("withdrawName").value.trim(),amount:Number(document.getElementById("withdrawAmount").value)})}); showToast("Withdrawal request submitted"); await loadWithdrawPage(); await refreshIdentity(); }
    catch(e){ showToast(e.message); }
}
async function loadProfile() {
    try { const d=await api("/api/profile"), p=d.profile || {}; renderUser(d.user); document.getElementById("profileCard").innerHTML=`<div><span>Telegram ID</span><strong>${p.telegram_user_id || "—"}</strong></div><div><span>Username</span><strong>${p.username ? "@"+p.username : "—"}</strong></div><div><span>Name</span><strong>${[p.first_name,p.last_name].filter(Boolean).join(" ") || "—"}</strong></div><div><span>Phone</span><strong>${p.phone_number || "—"}</strong></div><div><span>Referral code</span><strong>${p.referral_code || "—"}</strong></div><div><span>Total deposited</span><strong>${money(p.total_deposited)}</strong></div><div><span>Total withdrawn</span><strong>${money(p.total_withdrawn)}</strong></div><div><span>Total won</span><strong>${money(p.total_won)}</strong></div><div><span>Registered</span><strong>${p.registered_at || "—"}</strong></div>`; }
    catch(e){ showToast(e.message); }
}

async function safePanel(path, renderer, elementId) {
    try { const d=await api(path); renderer(d); }
    catch(e){ const el=document.getElementById(elementId); if(el) el.innerHTML=`<div class="notice">${e.message}</div>`; }
}

const grantLabels={dashboard:"Dashboard",deposits:"Deposits",withdrawals:"Withdrawals",player_balance:"Player Balance",player_bonus:"Player Bonus",bingo_rooms:"Bingo Games",bingo_settings:"Bingo Settings",commission:"Commission",settings:"General Settings",manage_admins:"Manage Admins"};

async function loadAdmin() {
    try {
        const info=await api("/api/admin");
        document.getElementById("adminSection").classList.remove("hidden");
        document.getElementById("adminTitle").textContent=info.is_super_admin?"👑 Super Admin":"🛡️ Admin";
        const grants=info.grants || [];
        const allowed=(key)=>info.is_super_admin || grants.includes(key);
        [
            ["adminPlayerPanel",allowed("player_balance")||allowed("player_bonus")],
            ["adminBingoPanel",allowed("bingo_rooms")],
            ["adminDepositsPanel",allowed("deposits")],
            ["adminWithdrawalsPanel",allowed("withdrawals")],
            ["adminSettingsPanel",allowed("settings")||allowed("commission")||allowed("bingo_settings")],
            ["adminManagementPanel",info.is_super_admin]
        ].forEach(([id,show])=>document.getElementById(id).classList.toggle("hidden",!show));

        document.getElementById("adminSummary").innerHTML=`<div class="admin-stat"><span>Commission</span><strong>${money(info.commission_percent)}%</strong></div><div class="admin-stat"><span>Permissions</span><strong>${info.is_super_admin?"ALL":grants.length}</strong></div>`;

        await Promise.all([
            safePanel("/api/admin/dashboard",d=>{const s=d.statistics||{}; document.getElementById("adminStats").innerHTML=`<div class="admin-stat"><span>Players</span><strong>${s.users||0}</strong></div><div class="admin-stat"><span>Deposited</span><strong>${money(s.deposited)}</strong></div><div class="admin-stat"><span>Withdrawn</span><strong>${money(s.withdrawn)}</strong></div><div class="admin-stat"><span>Pending deposits</span><strong>${s.pending_deposits||0}</strong></div><div class="admin-stat"><span>Pending withdrawals</span><strong>${s.pending_withdrawals||0}</strong></div>`;},"adminStats"),
            safePanel("/api/admin/bingo-games",d=>{document.getElementById("adminRooms").innerHTML=(d.rooms||[]).map(r=>`<div class="admin-row"><strong>Game #${r.id}</strong><span>Bet ${money(r.bet_amount)} · Cartels ${r.max_cards} · ${Number(r.is_active)?"ACTIVE":"DISABLED"}</span><div class="admin-actions"><button class="small-btn" data-action="edit-room" data-id="${r.id}" data-bet="${r.bet_amount}" data-cards="${r.max_cards}">Edit</button><button class="small-btn ${Number(r.is_active)?"danger":""}" data-action="toggle-room" data-id="${r.id}" data-active="${Number(r.is_active)?0:1}">${Number(r.is_active)?"Disable":"Enable"}</button></div></div>`).join("")||'<div class="notice">No games.</div>';},"adminRooms"),
            safePanel("/api/admin/deposits",d=>{document.getElementById("adminDeposits").innerHTML=(d.deposits||[]).map(x=>`<div class="admin-row"><strong>#${x.id} · ${money(x.amount)}</strong><span>${x.username?"@"+x.username:x.telegram_user_id}</span><div class="admin-actions"><button class="small-btn" data-action="approve-deposit" data-id="${x.id}">Approve</button><button class="small-btn danger" data-action="reject-deposit" data-id="${x.id}">Reject</button></div></div>`).join("")||'<div class="notice">No pending deposits.</div>';},"adminDeposits"),
            safePanel("/api/admin/withdrawals",d=>{document.getElementById("adminWithdrawals").innerHTML=(d.withdrawals||[]).map(x=>`<div class="admin-row"><strong>#${x.id} · ${money(x.amount)}</strong><span>${x.username?"@"+x.username:x.telegram_user_id}</span><div class="admin-actions"><button class="small-btn" data-action="approve-withdrawal" data-id="${x.id}">Approve</button><button class="small-btn danger" data-action="reject-withdrawal" data-id="${x.id}">Reject</button></div></div>`).join("")||'<div class="notice">No pending withdrawals.</div>';},"adminWithdrawals"),
            safePanel("/api/admin/settings",d=>{document.getElementById("adminCommission").value=d.commission_percent; document.getElementById("settingRegistrationBonus").value=d.registration_bonus; document.getElementById("settingReferralBonus").value=d.referral_bonus; document.getElementById("settingFirstDeposit").value=d.first_deposit_required; document.getElementById("settingMinWithdrawal").value=d.min_withdrawal; document.getElementById("settingMaxWithdrawal").value=d.max_withdrawal; document.getElementById("adminPatterns").innerHTML=(d.patterns||[]).map(p=>`<div class="admin-row pattern-row"><strong>${p.pattern_name}</strong><button class="small-btn ${Number(p.is_enabled)?"":"danger"}" data-action="toggle-pattern" data-key="${p.pattern_key}" data-enabled="${Number(p.is_enabled)?0:1}">${Number(p.is_enabled)?"Disable":"Enable"}</button></div>`).join("");},"adminPatterns"),
            safePanel("/api/admin/admins",d=>{document.getElementById("adminList").innerHTML=(d.admins||[]).map(a=>`<div class="admin-row"><strong>${a.telegram_user_id}</strong><span>${Number(a.is_active)?"ACTIVE":"INACTIVE"}</span><span>${(a.grants||[]).map(g=>grantLabels[g]||g).join(", ")||"No grants"}</span><div class="admin-actions"><button class="small-btn" data-action="toggle-admin" data-id="${a.telegram_user_id}" data-active="${Number(a.is_active)?0:1}">${Number(a.is_active)?"Deactivate":"Activate"}</button><button class="small-btn" data-action="load-admin-grants" data-id="${a.telegram_user_id}" data-grants="${(a.grants||[]).join(",")}">Edit Grants</button></div></div>`).join("")||'<div class="notice">No additional administrators.</div>';},"adminList"),
            safePanel("/api/admin/activity",d=>{document.getElementById("adminActivity").innerHTML=(d.activity||[]).map(x=>`<div class="admin-row"><strong>#${x.id} · ${x.action}</strong><span>${x.created_at || ""}</span><span>Admin ${x.admin_telegram_id}${x.target_telegram_id?" · Target "+x.target_telegram_id:""}</span><small>${x.details || ""}</small></div>`).join("")||'<div class="notice">No activity.</div>';},"adminActivity")
        ]);
        const choices=document.getElementById("grantChoices");
        if(info.is_super_admin) choices.innerHTML=(info.admin_grants||[]).map(g=>`<label class="grant-choice"><input type="checkbox" value="${g}"> ${grantLabels[g]||g}</label>`).join("");
    } catch(e) { document.getElementById("adminSection").classList.add("hidden"); showToast(e.message); }
}

async function adminAction(path,body=null,method="POST") {
    const options={method};
    if(body) { options.body=JSON.stringify(body); }
    await api(path,options);
    showToast("Admin action completed");
    await loadAdmin();
    await loadDashboard();
}

async function saveCommission(){ try{await adminAction("/api/admin/settings/commission",{percent:Number(document.getElementById("adminCommission").value)});}catch(e){showToast(e.message);} }
async function saveGeneralSettings(){ try{await adminAction("/api/admin/settings/general",{registration_bonus:Number(document.getElementById("settingRegistrationBonus").value),referral_bonus:Number(document.getElementById("settingReferralBonus").value),first_deposit_required:Number(document.getElementById("settingFirstDeposit").value),min_withdrawal:Number(document.getElementById("settingMinWithdrawal").value),max_withdrawal:Number(document.getElementById("settingMaxWithdrawal").value)});}catch(e){showToast(e.message);} }
async function adjustPlayerBalance(){ try{await adminAction("/api/admin/player-balance",{telegram_user_id:Number(document.getElementById("adminPlayerId").value),amount:Number(document.getElementById("adminBalanceAmount").value),balance_type:document.getElementById("adminBalanceType").value}); document.getElementById("adminBalanceAmount").value="";}catch(e){showToast(e.message);} }
async function addBingoGame(){ try{await adminAction("/api/admin/bingo-games",{bet_amount:Number(document.getElementById("newBetAmount").value),max_cards:Number(document.getElementById("newMaxCards").value)}); document.getElementById("newBetAmount").value=""; document.getElementById("newMaxCards").value="";}catch(e){showToast(e.message);} }
async function downloadBackup(){ try{const r=await fetch(API_BASE_URL+"/api/admin/database-backup",{headers:{"X-Telegram-Init-Data":tg.initData}}); if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.detail||"Backup failed");} const blob=await r.blob(); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download="bingo-backup.db"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000); showToast("Database backup ready");}catch(e){showToast(e.message);} }

async function createAdmin(){
    try {
        const id=Number(document.getElementById("newAdminId").value);
        const grants=[...document.querySelectorAll("#grantChoices input:checked")].map(x=>x.value);
        await adminAction("/api/admin/admins",{telegram_user_id:id,grants});
        document.getElementById("newAdminId").value="";
        document.querySelectorAll("#grantChoices input").forEach(x=>x.checked=false);
    } catch(e){showToast(e.message);}
}

async function editRoom(id,currentBet,currentCards){
    const bet=prompt(`New bet amount for Game #${id}:`,currentBet);
    if(bet===null)return;
    const cards=prompt(`New cartel count for Game #${id}:`,currentCards);
    if(cards===null)return;
    try{await adminAction(`/api/admin/bingo-games/${id}`,{bet_amount:Number(bet),max_cards:Number(cards)},"PATCH");}catch(e){showToast(e.message);}
}

async function editAdminGrants(id,current){
    const raw=prompt("Enter grant keys separated by commas:\n"+Object.entries(grantLabels).map(([k,v])=>`${k} = ${v}`).join("\n"),current);
    if(raw===null)return;
    try{await adminAction(`/api/admin/admins/${id}/grants`,{grants:raw.split(",").map(x=>x.trim()).filter(Boolean)},"PATCH");}catch(e){showToast(e.message);}
}

document.addEventListener("click",async e=>{
    const nav=e.target.closest(".nav-btn");
    if(nav){setPage(nav.dataset.page);return;}
    const room=e.target.closest(".clickable-room");
    if(room){openRoomFromDashboard(Number(room.dataset.room));return;}
    const action=e.target.closest("[data-action]");
    if(!action)return;
    try{
        const a=action.dataset.action;
        if(a==="approve-deposit")await adminAction(`/api/admin/deposits/${action.dataset.id}/approve`);
        else if(a==="reject-deposit")await adminAction(`/api/admin/deposits/${action.dataset.id}/reject`);
        else if(a==="approve-withdrawal")await adminAction(`/api/admin/withdrawals/${action.dataset.id}/approve`);
        else if(a==="reject-withdrawal")await adminAction(`/api/admin/withdrawals/${action.dataset.id}/reject`);
        else if(a==="toggle-pattern")await adminAction(`/api/admin/settings/patterns/${action.dataset.key}`,{enabled:action.dataset.enabled==="1"});
        else if(a==="toggle-room")await adminAction(`/api/admin/bingo-games/${action.dataset.id}`,{is_active:action.dataset.active==="1"},"PATCH");
        else if(a==="edit-room")await editRoom(Number(action.dataset.id),action.dataset.bet,action.dataset.cards);
        else if(a==="toggle-admin")await adminAction(`/api/admin/admins/${action.dataset.id}/active`,{active:action.dataset.active==="1"},"PATCH");
        else if(a==="load-admin-grants")await editAdminGrants(Number(action.dataset.id),action.dataset.grants || "");
    }catch(err){showToast(err.message);}
});

function openRoomFromDashboard(roomId){
    const room=rooms.find(r=>Number(r.room_id)===Number(roomId));
    if(room && ["PLAYING","WINNER","RESULT"].includes(room.status)) return openCallingPage(roomId);
    return openCartelPage(roomId);
}

document.getElementById("refreshBtn").addEventListener("click",()=>setPage(document.querySelector(".nav-btn.active")?.dataset.page || "dashboardPage"));
document.getElementById("backToDashboard").addEventListener("click",()=>setPage("dashboardPage"));
document.getElementById("backFromCalling").addEventListener("click",closeCalling);
document.getElementById("submitDeposit").addEventListener("click",submitDeposit);
document.getElementById("submitWithdrawal").addEventListener("click",submitWithdrawal);
document.getElementById("adminRefresh").addEventListener("click",loadAdmin);
document.getElementById("saveCommission").addEventListener("click",saveCommission);
document.getElementById("saveGeneralSettings").addEventListener("click",saveGeneralSettings);
document.getElementById("adminAdjustBalance").addEventListener("click",adjustPlayerBalance);
document.getElementById("addBingoGame").addEventListener("click",addBingoGame);
document.getElementById("createAdmin").addEventListener("click",createAdmin);
document.getElementById("downloadBackup").addEventListener("click",downloadBackup);

document.addEventListener("DOMContentLoaded",async()=>{
    initTelegram();
    try { await refreshIdentity(); setPage("dashboardPage"); }
    catch(e){ document.getElementById("error").textContent=e.message; document.getElementById("error").classList.remove("hidden"); }
});
