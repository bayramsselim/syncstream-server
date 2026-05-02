document.addEventListener('DOMContentLoaded', () => {
    const views = {
        init:   document.getElementById('view-init'),
        action: document.getElementById('view-action'),
        room:   document.getElementById('view-room')
    };

    const elements = {
        nameIn:      document.getElementById('name-in'),
        userNameLbl: document.getElementById('user-name-label'),
        joinCodeIn:  document.getElementById('join-code-in'),
        roomCodeDsp: document.getElementById('room-code-display'),
        btnNext:     document.getElementById('btn-next'),
        btnCreate:   document.getElementById('btn-create'),
        btnJoin:     document.getElementById('btn-join'),
        btnLeave:    document.getElementById('btn-leave'),
        btnCopy:     document.getElementById('btn-copy')
    };

    let myName = '';

    function showView(name) {
        Object.values(views).forEach(v => v.classList.remove('active'));
        views[name].classList.add('active');
    }

    // Step 1: Name
    elements.btnNext.onclick = () => {
        myName = elements.nameIn.value.trim();
        if (myName) {
            elements.userNameLbl.textContent = myName;
            showView('action');
        }
    };
    elements.nameIn.addEventListener('keypress', e => {
        if (e.key === 'Enter') elements.btnNext.click();
    });

    // Step 2: Create or Join — background.js handles the WS race condition
    elements.btnCreate.onclick = () => {
        chrome.runtime.sendMessage({ type: 'CREATE_ROOM', username: myName });
    };

    elements.btnJoin.onclick = () => {
        const code = elements.joinCodeIn.value.trim().toUpperCase();
        if (code.length < 4) { alert('Please enter a valid room code.'); return; }
        chrome.runtime.sendMessage({ type: 'JOIN_ROOM', roomId: code, username: myName });
    };
    elements.joinCodeIn.addEventListener('keypress', e => {
        if (e.key === 'Enter') elements.btnJoin.click();
    });

    // Step 3: Room view
    elements.btnLeave.onclick = () => {
        chrome.runtime.sendMessage({ type: 'LEAVE_ROOM' });
        showView('init');
    };

    elements.btnCopy.onclick = () => {
        const code = elements.roomCodeDsp.textContent;
        navigator.clipboard.writeText(code).then(() => {
            elements.btnCopy.textContent = 'COPIED!';
            setTimeout(() => { elements.btnCopy.textContent = 'COPY CODE'; }, 2000);
        });
    };

    // Listen for state changes (e.g. from background.js when room is created/joined)
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'ROOM_STATE' && msg.data?.roomId) {
            elements.roomCodeDsp.textContent = msg.data.roomId;
            showView('room');
        } else if (msg.type === 'JOIN_ERROR') {
            alert(msg.message || 'Could not join room.');
        }
    });

    // Restore state on popup open
    chrome.runtime.sendMessage({ type: 'GET_ROOM_STATE' }, (res) => {
        if (res?.roomId) {
            elements.roomCodeDsp.textContent = res.roomId;
            showView('room');
        }
    });
});
