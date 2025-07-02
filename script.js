// ====== script.js ======

// ====== Firebase init ======
const firebaseConfig = {
  apiKey: "AIzaSyA56dNFvNZHboPvV7p0GzK3T7CrSx_Bo7A",
  authDomain: "geo-rtd-b20e3.firebaseapp.com",
  databaseURL: "https://geo-rtd-b20e3-default-rtdb.firebaseio.com",
  projectId: "geo-rtd-b20e3",
  storageBucket: "geo-rtd-b20e3.appspot.com",
  messagingSenderId: "387335406401",
  appId: "1:387335406401:web:4ef6acd68eaabe4014d7c0"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ====== API & URLs ======
const API_KEY        = 'AIzaSyAhhc-XUJAe3y5-1WtInhr2FemqKVg9JhM';
// restored original Z
const SHEET_ID       = '1HAjSlwQYDkR0iECQhKZ3rO788KvyhllfkawwcmzNpmg';

const MAIN_SHEET     = 'RTM';
const BREAK_SHEET    = 'Pre-Break Bot Data';
const SHIFTS_SHEET   = 'Shifts Quinyx';
const CURRENT_SHEET  = 'Current Shift';
// exact tab name
const EMPLOYEE_SHEET = 'Employee list';

const REFRESH_INTERVAL = 15; // seconds
let countdown = REFRESH_INTERVAL;

// debug log
const dbg = document.getElementById('debug-log');
if (dbg) dbg.textContent = '';

// build URLs
const MAIN_URL     = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(MAIN_SHEET)}!A:AD?key=${API_KEY}&valueRenderOption=FORMATTED_VALUE`;
const BREAK_URL    = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(BREAK_SHEET)}!A:D?key=${API_KEY}&valueRenderOption=FORMATTED_VALUE`;
const SHIFTS_URL   = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(SHIFTS_SHEET)}!A:H?key=${API_KEY}&valueRenderOption=FORMATTED_VALUE`;
const CURRENT_URL  = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(CURRENT_SHEET)}!A:F?key=${API_KEY}&valueRenderOption=FORMATTED_VALUE`;
const EMPLOYEE_URL = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(EMPLOYEE_SHEET)}!A:E?key=${API_KEY}&valueRenderOption=FORMATTED_VALUE`;

let trendData = [];
let trendChart, trendCtx, historyRange;
let distributionChart = null;
let employeeMasterList = [];
// словарь для соответствия "Имя сотрудника" → "ConverseId"
let employeeIdMap = {};


// ====== Startup ======
window.onload = async () => {
  // weekly prune trendPoints
  const WEEK_MS = 7*24*3600*1000;
  const nowTs = Date.now();
  const metaRef = db.ref('cleanup/lastPruneWeekly');
  const lastPruneSnap = await metaRef.once('value');
  const lastPrune = lastPruneSnap.val() ? Date.parse(lastPruneSnap.val()) : 0;
  if (nowTs - lastPrune >= WEEK_MS) {
    await db.ref('trendPoints').remove();
    await metaRef.set(new Date(nowTs).toISOString());
    dbg && (dbg.textContent += `✅ Pruned weekly at ${new Date(nowTs).toISOString()}\n`);
  }

  // load saved trend points
  db.ref('trendPoints').on('value', snap => {
    trendData = [];
    snap.forEach(ch => {
      const v = ch.val();
      trendData.push({ t:new Date(v.t), a:v.a, s:v.s });
    });
    updateTrendChart();
  });

// load employee list + build map name→ID
fetch(EMPLOYEE_URL)
  .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
  .then(j => {
    const rows = (j.values||[]).slice(1);
    rows.forEach(r => {
      const name = r[2];      // столбец C: имя
      const id   = r[4];      // столбец E: ConverseId
      if (name && id) {
        employeeIdMap[name] = id;
      }
    });
    // список имён для поиска
    employeeMasterList = Object.keys(employeeIdMap);
    fillEmployeeDatalist();
  })
  .catch(e => dbg && (dbg.textContent += `Employee list error: ${e}\n`));


  // initialize dashboard
  initDashboard();
  startHeaderTimer();
  feather.replace();
  
  tippy('.info-icon', {
    theme: 'light-border',
    delay: [100, 50],
    arrow: true,
    placement: 'top',
    // первый параметр — горизонтальный сдвиг (отрицательное = влево)
    offset: [-6, 15],
  });
  
  setInterval(initDashboard, REFRESH_INTERVAL*1000);
  setInterval(updateTrendData,     3600*1000);
  setInterval(fetchCurrent,        60*1000);
};

// ====== Dashboard init ======
function initDashboard(){
  countdown = REFRESH_INTERVAL;

  // init trend chart once
  const cv = document.getElementById('active-trend-chart');
  const rg = document.getElementById('history-range');
  if (cv && rg && !trendChart) {
    trendCtx = cv.getContext('2d');
    historyRange = rg;
    historyRange.addEventListener('input', updateTrendChart);
    initTrendChart();
  }

  fetchMain();
  fetchBreaks();
  fetchShifts();
  fetchCurrent();
}

// ====== Header timer ======
function startHeaderTimer(){
  const el = document.getElementById('header-timer');
  function tick(){
    el.textContent = `Auto-refresh in ${String(countdown).padStart(2,'0')}s..`;
    countdown = Math.max(0, countdown-1);
  }
  tick();
  setInterval(tick,1000);
}

// ====== Parsers ======
function parseDateTime(dt){
  if(!dt||!dt.includes(' ')) return null;
  const [d,t] = dt.split(' '),
        [day,mo,yr] = d.split('/').map(Number),
        [hh,mm,ss] = t.split(':').map(Number);
  return new Date(yr,mo-1,day,hh,mm,ss);
}
function parseDateOnly(str){
  const p = str.split('-').map(Number);
  return p.length===3 ? new Date(p[0],p[1]-1,p[2]) : null;
}
function parseTimeOnly(str){
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(str);
  if(!m) return null;
  const hh=+m[1], mm=+m[2], ss=+m[3]||0,
        now=new Date();
  return new Date(now.getFullYear(),now.getMonth(),now.getDate(),hh,mm,ss);
}
function parseDuration(str){
  const p=str.split(':').map(Number);
  return p.length===2 ? p[0]*60+p[1] : p[0]*3600+p[1]*60+(p[2]||0);
}

// ====== Fetch & render ======
function fetchMain(){
  dbg&&(dbg.textContent+='FETCH MAIN\n');
  fetch(MAIN_URL)
    .then(r=>r.ok?r.json():Promise.reject(r.statusText))
    .then(j=> {
      updateMetrics(j.values||[]);
      const rows = (j.values||[]).slice(1)
        .map(a=>({ c: Array.from({length:21},(_,i)=>({v:a[i]||null})) }));
      renderLists(rows);
    })
    .catch(e=>dbg&&(dbg.textContent+=`MAIN error: ${e}\n`));
}

function fetchBreaks(){
  dbg&&(dbg.textContent+='FETCH BREAKS\n');
  fetch(BREAK_URL)
    .then(r=>r.ok?r.json():Promise.reject(r.statusText))
    .then(j=>renderBreaks((j.values||[]).slice(1)))
    .catch(e=>dbg&&(dbg.textContent+=`BREAKS error: ${e}\n`));
}

function fetchShifts(){
  dbg&&(dbg.textContent+='FETCH SHIFTS\n');
  fetch(SHIFTS_URL)
    .then(r=>r.ok?r.json():Promise.reject(r.statusText))
    .then(j=>updateUpcoming((j.values||[]).slice(2)))
    .catch(e=>dbg&&(dbg.textContent+=`SHIFTS error: ${e}\n`));
}

function fetchCurrent(){
  dbg&&(dbg.textContent+='FETCH CURRENT\n');
  fetch(CURRENT_URL)
    .then(r=>r.ok?r.json():Promise.reject(r.statusText))
    .then(j=> {
      const rows = (j.values||[]).slice(1);
      renderCurrent(rows);
      renderDistribution(rows);
    })
    .catch(e=>dbg&&(dbg.textContent+=`CURRENT error: ${e}\n`));
}

// ====== Metrics cards ======
function updateMetrics(vals) {
  const r2 = vals[1] || [], r5 = vals[4] || [];
  const data = [
    ['Active Teammates',   r2[23] || '–', null],
    ['Should be',          r2[25] || '–', null],
    ['Pre-Away Teammates', r2[27] || '–', null],
    ['Away Teammates',     r2[29] || '–', null],
    ['Not coming today',   r5[23] || '–', (r5[23] || '').split(',')],
    ['Not here',           r5[25] || '–', (r5[25] || '').split(',')]
  ];

  const cont = document.getElementById('metrics-container');
  cont.innerHTML = '';

  data.forEach(([t, v, l]) => {
    const flip = Array.isArray(l) && l[0] !== '';
    const card = document.createElement('div');

    // Определяем цветовую категорию
    let typeClass = '';
    if (t === 'Active Teammates') typeClass = 'active';
    if (t === 'Should be') typeClass = 'shouldbe';
    if (t === 'Pre-Away Teammates') typeClass = 'preaway';
    if (t === 'Away Teammates') typeClass = 'away';
    if (t === 'Not coming today') typeClass = 'notcomingtoday';

    // Добавляем классы
    card.className = 'metric-card' + (flip ? ' flip-card' : '') + (typeClass ? ` ${typeClass}` : '');

    // Подсвечиваем блок "Not here", если есть сотрудники
    if (t === 'Not here' && flip) {
      card.classList.add('alert');
    }

    if (flip) {
      card.innerHTML = `
        <div class="flip-inner">
          <div class="flip-front">
            <div class="metric-title">${t}</div>
            <div class="metric-value">${l.length}</div>
          </div>
          <div class="flip-back">
            <div class="metric-title">${t}</div>
            <div class="metric-list">${l.map(n => `<div>${n.trim()}</div>`).join('')}</div>
          </div>
        </div>`;
    } else {
      card.innerHTML = `
        <div class="metric-title">${t}</div>
        <div class="metric-value">${v}</div>`;
    }

    cont.appendChild(card);
  });
}



// ====== Lists rendering ======
function renderLists(rows){
  ['active-list','pre-away-list','away-list'].forEach(id=>
    document.getElementById(id).innerHTML=''
  );
  rows.forEach(r=>{
    if(r.c[0].v) document.getElementById('active-list')
      .appendChild(makeEmployee(r.c[0].v,r.c[1].v,null,null,{countdown:false,alertOnOver:false}));
    if(r.c[7].v) document.getElementById('pre-away-list')
      .appendChild(makeEmployee(r.c[7].v,r.c[8].v,r.c[9].v,r.c[12].v,{countdown:false,alertOnOver:true}));
    if(r.c[15].v){
      const st=r.c[16].v||'', brb=/break|brb/i.test(st);
      document.getElementById('away-list')
        .appendChild(makeEmployee(r.c[15].v,st,r.c[17].v,r.c[20].v,{countdown:brb,alertOnOver:brb}));
    }
  });
}

function fillEmployeeDatalist(){
  const dl = document.getElementById('employees-list');
  dl.innerHTML = employeeMasterList.map(n => `<option value="${n}">`).join('');

  const inp = document.getElementById('employee-search');
  inp.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.employee').forEach(li => {
      const matches = q && li.textContent.toLowerCase().includes(q);
      li.classList.toggle('search-match', matches);
    });
  });
}


// ====== Breaks ======
function renderBreaks(rows){
  const el=document.getElementById('breaks-list'); el.innerHTML='';
  rows.forEach(r=>{
    const [em,b1,b2]=r;
    if(!b1&&!b2) return;
    const login=em.split('@')[0];
    const parts=login.split('.');
    const name = parts.length===2
      ? parts.map(p=>p[0].toUpperCase()+p.slice(1)).join(' ')
      : login;
    const t1=b1.split(',').pop().trim();
    const t2=b2.split(',').pop().trim();
    const li=document.createElement('li');
    li.className='employee';
    li.innerHTML = `<span class="employee-name">${name}</span><span class="timer">${t1}</span><span class="timer">${t2}</span>`;
    el.appendChild(li);
  });
}

// ====== Upcoming ======
function updateUpcoming(rows){
  const now=Date.now(),hr=3600*1000,out=[];
  rows.forEach(r=>{
    const fam=r[2],giv=r[3],ds=r[5],ss=r[6];
    const d=parseDateOnly(ds);
    if(!d||!ss) return;
    const t=ss.split('-')[0].trim();
    const [hh,mm]=t.split(':').map(Number);
    const st=new Date(d.getFullYear(),d.getMonth(),d.getDate(),hh,mm).getTime();
    if(st>=now&&st<=now+hr) out.push({name:`${giv} ${fam}`,time:ss});
  });
  const ul=document.getElementById('upcoming-list'); ul.innerHTML='';
  out.forEach(u=>{
    const li=document.createElement('li');
    li.className='employee';
    li.innerHTML = `<span class="employee-name">${u.name}</span><span class="timer">${u.time}</span>`;
    ul.appendChild(li);
  });
}

// ====== Current & Distribution ======
function renderCurrent(rows){
  const tb = document.getElementById('current-list');
  tb.innerHTML = '';
  rows.forEach(r=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r[2]||''}</td><td>${r[3]||''}</td><td>${r[4]||''}</td><td>${r[5]||''}</td>`;
    tb.appendChild(tr);
  });
}

function renderDistribution(rows){
  const cnt = new Array(24).fill(0);
  rows.forEach(r=>{
    const sd=parseDateTime(r[4]), ed=parseDateTime(r[5]);
    if(!sd||!ed) return;
    let cur=new Date(sd);
    cur.setMinutes(0,0,0,0);
    if(cur>sd) cur=new Date(cur.getTime()-3600000);
    while(cur<ed){
      cnt[cur.getHours()]++;
      cur=new Date(cur.getTime()+3600000);
    }
  });
  const labels=cnt.map((_,i)=>`${String(i).padStart(2,'0')}:00`);
  if(distributionChart){
    distributionChart.data.labels=labels;
    distributionChart.data.datasets[0].data=cnt;
    distributionChart.update();
  } else {
    const ctx=document.getElementById('hour-distribution-chart').getContext('2d');
    distributionChart=new Chart(ctx,{
      type:'bar',
      data:{labels,datasets:[{
        label:'Employees on shift',
        data:cnt,
        backgroundColor:'rgba(54,162,235,0.6)',
        borderColor:'rgba(54,162,235,1)',
        borderWidth:1
      }]},
      options:{scales:{
        x:{title:{display:true,text:'Hour of Day'},grid:{display:false}},
        y:{beginAtZero:true,title:{display:true,text:'Number'},ticks:{stepSize:1}}
      },plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false}},maintainAspectRatio:false}
    });
  }
}

// ====== Employee helper ======
function makeEmployee(name, label, from, plan, opts) {
  const { countdown, alertOnOver } = opts;
  const li = document.createElement('li');
  li.className = 'employee';

  // 1) Имя (ссылка на Converse по id)
  const nm = document.createElement('a');
  nm.className = 'employee-name';
  nm.textContent = name;
  const id = employeeIdMap[name];
  if (id) {
    nm.href   = `https://ops.wolt.com/support/converse/users/conversations?assigneeIds=${id}`;
    nm.target = '_blank';
  } else {
    nm.href = '#';
    nm.addEventListener('click', e => e.preventDefault());
  }
  li.appendChild(nm);

  // 2) Оборачиваем бейдж + таймер в единый контейнер
  const meta = document.createElement('div');
  meta.className = 'employee-meta';

  // 2.1) Бейдж статуса (если есть)
  if (label) {
    const bd = document.createElement('span');
    const cssLabel = label.toLowerCase().trim();
    let labelClass = '';
    if (cssLabel === 'on shift')   labelClass = 'active';
    else if (cssLabel === 'brb')    labelClass = 'brb';
    else if (cssLabel === 'break')  labelClass = 'break';
    else if (cssLabel === 'meeting')labelClass = 'meeting';
    else if (cssLabel === 'shift end') labelClass = 'shiftend';

    bd.className = 'employee-badge' + (labelClass ? ` ${labelClass}` : '');
    bd.textContent = label;
    meta.appendChild(bd);
  }

  // 2.2) Таймер
  const tm = document.createElement('span');
  tm.className = 'timer';
  meta.appendChild(tm);

  // Вставляем meta в li
  li.appendChild(meta);

  // 3) Расчёт и запуск таймера
  let sd = null, ps = 0;
  if (typeof from === 'string')
    sd = from.includes('/') ? parseDateTime(from) : parseTimeOnly(from);
  if (typeof plan === 'string')
    ps = parseDuration(plan);

  function tick() {
    if (!sd) {
      tm.textContent = '';
      return;
    }
    const nowS = Math.floor(Date.now() / 1000),
          stS  = Math.floor(sd.getTime() / 1000),
          el   = nowS - stS,
          disp = countdown ? ps - el : el,
          sign = disp < 0 ? '-' : '',
          a    = Math.abs(disp),
          h    = Math.floor(a / 3600),
          m    = Math.floor((a % 3600) / 60),
          s    = a % 60;

    tm.textContent = `${sign}${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    if ((!countdown && alertOnOver && el > ps) || (countdown && alertOnOver && disp < 0)) {
      nm.style.color = '#f44336';
    }
  }

  if (sd) {
    tick();
    setInterval(tick, 1000);
  }

  return li;
}



function initTrendChart() {
  trendChart = new Chart(trendCtx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Active',
          data: [],
          tension: 0.2,
          borderColor: '#36A2EB',
          backgroundColor: 'rgba(54, 162, 235, 0.2)',
          pointRadius: 3,
          pointHoverRadius: 6
        },
        {
          label: 'Should be',
          data: [],
          tension: 0.2,
          borderColor: '#FF6384',
          backgroundColor: 'rgba(255, 99, 132, 0.2)',
          pointRadius: 3,
          pointHoverRadius: 6
        }
      ]
    },
    options: {
      interaction: {
        mode: 'index',
        intersect: false,
        axis: 'x'
      },
      plugins: {
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            title: function (items) {
              const raw = items[0].label;
              const d = new Date(raw);
              const dd = String(d.getDate()).padStart(2, '0');
              const mm = String(d.getMonth() + 1).padStart(2, '0');
              const hh = String(d.getHours()).padStart(2, '0');
              const min = String(d.getMinutes()).padStart(2, '0');
              return `${dd}.${mm} ${hh}:${min}`;
            }
          }
        },
        legend: {
          position: 'top'
        }
      },
      scales: {
        x: {
          ticks: {
            callback: function(value) {
              const date = this.getLabelForValue(value);
              const d = new Date(date);
              const dd = String(d.getDate()).padStart(2, '0');
              const mm = String(d.getMonth() + 1).padStart(2, '0');
              const hh = String(d.getHours()).padStart(2, '0');
              const min = String(d.getMinutes()).padStart(2, '0');
              return `${dd}.${mm} ${hh}:${min}`;
            }
          }
        },
        y: {
          beginAtZero: true
        }
      },
      maintainAspectRatio: false
    }
  });
}




function updateTrendData(){
  let a=0,s=0;
  document.querySelectorAll('#metrics-container .metric-card').forEach(c=>{
    const t=c.querySelector('.metric-title').textContent;
    const v=parseInt(c.querySelector('.metric-value').textContent,10)||0;
    if(t==='Active Teammates') a=v;
    if(t==='Should be') s=v;
  });
  const now=new Date().toISOString();
  trendData.push({t:new Date(now),a,s});
  db.ref('trendPoints').push({t:now,a,s});
}

function updateTrendChart(){
  const pts=parseInt(historyRange.value,10);
  const slice=trendData.slice(-pts);
  trendChart.data.labels=slice.map(p=>p.t);
  trendChart.data.datasets[0].data=slice.map(p=>p.a);
  trendChart.data.datasets[1].data=slice.map(p=>p.s);
  trendChart.update();
}
// ====== Collapse logic for Current Shifts ======
document.addEventListener('DOMContentLoaded', () => {
  const collapseCard = document.getElementById('current-card');
  const toggleBtn = collapseCard?.querySelector('.toggle-btn');
  if (collapseCard && toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const collapsed = collapseCard.classList.toggle('collapsed');
      toggleBtn.setAttribute('aria-expanded', String(!collapsed));
    });
  }
});
// —————————— Тема ——————————

const themeToggleBtn = document.getElementById('theme-toggle');
const currentTheme = localStorage.getItem('theme') || 'light';

function applyTheme(name) {
  document.body.classList.toggle('dark-theme', name === 'dark');
  themeToggleBtn.textContent = name === 'dark' ? '☀️' : '🌙';
}

themeToggleBtn.addEventListener('change', e => {
  const newTheme = e.target.checked ? 'dark' : 'light';
  localStorage.setItem('theme', newTheme);
  applyTheme(newTheme);
});


// при загрузке страницы
applyTheme(currentTheme);
// синхронизируем внешний вид переключателя
themeToggleBtn.checked = (currentTheme === 'dark');
// переключаем класс dark-theme на <body>

// ==== Toggle и обводка строки для Current Shifts ====
window.addEventListener('load', () => {
  const card            = document.getElementById('current-card');
  const searchBtn       = card.querySelector('.search-btn');
  const searchContainer = card.querySelector('.search-container');
  const input           = card.querySelector('#current-search');

  // Показ/скрытие поиска
  searchBtn.addEventListener('click', () => {
    searchContainer.classList.toggle('visible');
    if (!searchContainer.classList.contains('visible')) {
      // при закрытии сброс рамок и очистка поля
      input.value = '';
      card.querySelectorAll('#current-list tr').forEach(tr => {
        tr.style.outline = '';
      });
    } else {
      input.focus();
    }
  });

  // На каждый ввод — обводим строки, где имя совпало
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    let firstFound = null;

    card.querySelectorAll('#current-list tr').forEach(tr => {
      const name = tr.children[0].textContent.toLowerCase();
      if (q && name.includes(q)) {
        // ставим жёлтую рамку
        tr.style.outline = '2px solid #FFD54F';
        // опционально можно сделать скругление углов:
        tr.style.outlineOffset = '-1px';
        if (!firstFound) firstFound = tr;
      } else {
        tr.style.outline = '';
      }
    });

    // и скроллим к первому совпадению
    if (firstFound) {
      firstFound.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
});
