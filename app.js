(() => {
  'use strict';

  const data = window.CRIMSONWOOD_DATA;
  if (!data) {
    document.body.textContent = '지도 데이터를 불러오지 못했습니다.';
    document.body.classList.add('data-error');
    return;
  }

  const $ = selector => document.querySelector(selector);
  const cleanNode = value => String(value || '').replace(/[()\[\]]/g, '');
  const imageUrl = filename => `maps/${filename.split('/').map(encodeURIComponent).join('/')}`;
  const STORAGE_KEY = 'crimsonwood-navi-state-v3';
  const MAX_PATHS = 8;

  const elements = {
    start: $('#start-input'), end: $('#end-input'), upper: $('#upper-toggle'),
    startOptions: $('#start-options'), endOptions: $('#end-options'),
    swap: $('#swap-button'), favorite: $('#favorite-button'),
    favorites: $('#favorites'), clearFavorites: $('#clear-favorites'),
    empty: $('#empty-state'), results: $('#results-section'), title: $('#result-title'),
    description: $('#result-description'), tabs: $('#route-tabs'), content: $('#route-content'),
    toast: $('#toast'),
    dialog: $('#image-dialog'), dialogImage: $('#dialog-image'), dialogCaption: $('#dialog-caption')
  };

  const adjacency = new Map();
  const exactNodes = new Set();
  const displayToExact = new Map();
  data.edges.forEach((edge, edgeIndex) => {
    exactNodes.add(edge.from); exactNodes.add(edge.to);
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push({ ...edge, edgeIndex });
    for (const node of [edge.from, edge.to]) {
      const display = cleanNode(node);
      if (!displayToExact.has(display)) displayToExact.set(display, []);
      if (!displayToExact.get(display).includes(node)) displayToExact.get(display).push(node);
    }
  });

  let state = loadState();
  let currentRoutes = [];
  let activeRoute = 0;
  let toastTimer;
  let resizeTimer;

  function loadState() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem('crimsonwood-navi-state-v2'));
      return {
        start: stored?.start || data.defaults.start,
        end: stored?.end || data.defaults.end,
        upper: Boolean(stored?.upper),
        bookmarks: Array.isArray(stored?.bookmarks) ? stored.bookmarks : data.defaultBookmarks,
        activeRoute: Number.isInteger(stored?.activeRoute) ? stored.activeRoute : 0
      };
    } catch {
      return { ...data.defaults, bookmarks: data.defaultBookmarks, activeRoute: 0 };
    }
  }

  function saveState() {
    state.start = elements.start.value.trim();
    state.end = elements.end.value.trim();
    state.upper = elements.upper.checked;
    state.activeRoute = activeRoute;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function initialize() {
    elements.start.value = state.start;
    elements.end.value = state.end;
    elements.upper.checked = state.upper;
    renderFavorites();
    bindEvents();

    if (state.start && state.end && data.nodes.includes(state.start) && data.nodes.includes(state.end)) searchRoutes(false, true);
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  function bindEvents() {
    elements.swap.addEventListener('click', () => {
      [elements.start.value, elements.end.value] = [elements.end.value, elements.start.value];
      searchRoutes(true);
    });
    elements.favorite.addEventListener('click', addFavorite);
    elements.clearFavorites.addEventListener('click', () => {
      if (!state.bookmarks.length || !confirm('즐겨찾기를 모두 지울까요?')) return;
      state.bookmarks = []; saveState(); renderFavorites(); showToast('즐겨찾기를 모두 지웠습니다.');
    });
    elements.upper.addEventListener('change', () => { saveState(); if (elements.start.value && elements.end.value) searchRoutes(false); });
    setupCombobox(elements.start, elements.startOptions);
    setupCombobox(elements.end, elements.endOptions);
    [elements.start, elements.end].forEach(input => input.addEventListener('change', () => {
      saveState();
      autoSearchIfReady();
    }));
    document.querySelectorAll('.clear-input').forEach(button => button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.target); input.value = ''; input.focus(); saveState();
    }));
    $('#dialog-close').addEventListener('click', () => elements.dialog.close());
    elements.dialog.addEventListener('click', event => { if (event.target === elements.dialog) elements.dialog.close(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && elements.dialog.open) elements.dialog.close(); });
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (currentRoutes[activeRoute]) renderRouteContent(currentRoutes[activeRoute]); }, 120);
    });
    window.addEventListener('pagehide', saveState);
    window.addEventListener('beforeunload', saveState);
  }

  function setupCombobox(input, list) {
    let activeIndex = -1;
    const close = () => { list.classList.remove('open'); input.setAttribute('aria-expanded', 'false'); activeIndex = -1; };
    const choose = value => {
      input.value = value;
      saveState();
      close();
      input.focus();
      autoSearchIfReady();
    };
    const render = (query = '', showAll = false) => {
      const keyword = query.trim().toLocaleLowerCase('ko');
      const matches = data.nodes.filter(node => showAll || !keyword || node.toLocaleLowerCase('ko').includes(keyword));
      list.innerHTML = matches.map((node, index) => `<button type="button" class="suggestion-option" role="option" data-index="${index}" data-value="${escapeHtml(node)}">${escapeHtml(node)}</button>`).join('');
      list.classList.toggle('open', matches.length > 0);
      input.setAttribute('aria-expanded', matches.length > 0 ? 'true' : 'false');
      activeIndex = -1;
      list.querySelectorAll('.suggestion-option').forEach(option => option.addEventListener('mousedown', event => {
        event.preventDefault(); choose(option.dataset.value);
      }));
    };
    const setActive = next => {
      const options = [...list.querySelectorAll('.suggestion-option')]; if (!options.length) return;
      activeIndex = (next + options.length) % options.length;
      options.forEach((option, index) => option.classList.toggle('active', index === activeIndex));
      options[activeIndex].scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('focus', () => render('', true));
    input.addEventListener('click', () => render('', true));
    input.addEventListener('input', () => render(input.value, false));
    input.addEventListener('blur', () => setTimeout(close, 100));
    input.addEventListener('keydown', event => {
      const options = [...list.querySelectorAll('.suggestion-option')];
      if (event.key === 'ArrowDown') { event.preventDefault(); if (!list.classList.contains('open')) render('', true); else setActive(activeIndex + 1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(activeIndex - 1); }
      else if (event.key === 'Escape') close();
      else if (event.key === 'Enter') {
        event.preventDefault();
        if (list.classList.contains('open') && activeIndex >= 0 && options[activeIndex]) choose(options[activeIndex].dataset.value);
        else { close(); searchRoutes(true); }
      }
    });
  }

  function resolveNode(display, preferUpper = false) {
    const value = display.trim();
    if (!value) return null;
    if (preferUpper && exactNodes.has(`(${value})`)) return `(${value})`;
    if (exactNodes.has(value)) return value;
    const matches = displayToExact.get(cleanNode(value)) || [];
    if (preferUpper) return matches.find(node => node.startsWith('(')) || matches[0] || null;
    return matches.find(node => !/^[([]/.test(node)) || matches[0] || null;
  }

  function autoSearchIfReady() {
    const start = cleanNode(elements.start.value.trim());
    const end = cleanNode(elements.end.value.trim());
    if (data.nodes.includes(start) && data.nodes.includes(end)) searchRoutes(false);
  }

  function shortestPaths(start, end) {
    if (start === end) return [{ nodes: [start], edges: [] }];
    const distance = new Map([[start, 0]]);
    const parents = new Map();
    const queue = [start];
    let cursor = 0;
    while (cursor < queue.length) {
      const node = queue[cursor++];
      const nextDistance = distance.get(node) + 1;
      if (distance.has(end) && nextDistance > distance.get(end)) continue;
      for (const edge of adjacency.get(node) || []) {
        if (!distance.has(edge.to)) {
          distance.set(edge.to, nextDistance); parents.set(edge.to, [{ node, edge }]); queue.push(edge.to);
        } else if (distance.get(edge.to) === nextDistance) {
          parents.get(edge.to).push({ node, edge });
        }
      }
    }
    if (!distance.has(end)) return [];

    const paths = [];
    const build = (node, nodes, edges) => {
      if (paths.length >= MAX_PATHS) return;
      if (node === start) {
        paths.push({ nodes: [start, ...nodes], edges: [...edges] });
        return;
      }
      for (const parent of parents.get(node) || []) build(parent.node, [node, ...nodes], [parent.edge, ...edges]);
    };
    build(end, [], []);
    return paths;
  }

  function searchRoutes(scroll = true, restoreActive = false) {
    const startDisplay = elements.start.value.trim();
    const endDisplay = elements.end.value.trim();
    if (!startDisplay || !endDisplay) return showToast('출발지와 도착지를 모두 선택해주세요.');
    if (!data.nodes.includes(cleanNode(startDisplay)) || !data.nodes.includes(cleanNode(endDisplay))) return showToast('목록에 있는 지역명을 선택해주세요.');

    const start = resolveNode(startDisplay);
    let target = resolveNode(endDisplay, elements.upper.checked);
    let routes = start && target ? shortestPaths(start, target) : [];
    if (!routes.length && elements.upper.checked) {
      target = resolveNode(endDisplay, false);
      routes = start && target ? shortestPaths(start, target) : [];
    }
    if (!routes.length) {
      currentRoutes = [];
      elements.results.hidden = true; elements.empty.hidden = false;
      elements.empty.querySelector('h2').textContent = '연결된 경로를 찾지 못했습니다';
      elements.empty.querySelector('p:last-child').textContent = '출발지와 도착지 조합을 바꾸거나 상단 지형 우선 옵션을 해제해보세요.';
      return;
    }

    currentRoutes = routes;
    activeRoute = restoreActive ? Math.max(0, Math.min(Number(state.activeRoute) || 0, routes.length - 1)) : 0;
    saveState(); renderRoutes();
    if (scroll) elements.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderRoutes() {
    const start = elements.start.value.trim();
    const end = elements.end.value.trim();
    elements.empty.hidden = true; elements.results.hidden = false;
    elements.title.textContent = `${start} → ${end}`;
    elements.description.textContent = `${currentRoutes[0].edges.length}번 이동 · 최단 경로 ${currentRoutes.length}개${currentRoutes.length === MAX_PATHS ? ' (최대 8개 표시)' : ''}`;
    elements.tabs.innerHTML = currentRoutes.map((route, index) => {
      const skill = route.nodes.some(node => node.includes('['));
      return `<button class="route-tab" type="button" role="tab" aria-selected="${index === activeRoute}" data-route="${index}">${skill ? '⚡ ' : ''}경로 ${index + 1}</button>`;
    }).join('');
    elements.tabs.querySelectorAll('.route-tab').forEach(button => button.addEventListener('click', () => {
      activeRoute = Number(button.dataset.route); saveState(); renderRoutes();
    }));
    renderRouteContent(currentRoutes[activeRoute]);
  }

  function renderRouteContent(route) {
    const overview = route.nodes.map((node, index) => {
      const skill = node.includes('[') ? ' skill' : '';
      return `${index ? '<span class="route-arrow">›</span>' : ''}<span class="route-node${skill}">${escapeHtml(cleanNode(node))}</span>`;
    }).join('');

    const cards = route.edges.map((edge, index) => {
      const skill = edge.from.includes('[');
      return `<article class="route-card">
        <div class="card-kicker"><span>STEP ${String(index + 1).padStart(2, '0')}</span>${skill ? '<span class="skill-badge">스킬 필요</span>' : ''}</div>
        <h3><b>${escapeHtml(cleanNode(edge.from))}</b> → ${escapeHtml(cleanNode(edge.to))}</h3>
        <button class="map-button" type="button" data-image="${escapeHtml(edge.image)}" data-caption="${escapeHtml(`${cleanNode(edge.from)} → ${cleanNode(edge.to)}`)}">
          <img src="${imageUrl(edge.image)}" alt="${escapeHtml(`${cleanNode(edge.from)}에서 ${cleanNode(edge.to)}로 이동하는 지도`)}" loading="lazy" decoding="async">
        </button>
      </article>`;
    });

    const finalName = cleanNode(route.nodes.at(-1));
    const finalImage = data.destinationImages[finalName] || route.edges.at(-1)?.image;
    if (finalImage) cards.push(`<article class="route-card destination-card">
      <div class="card-kicker"><span>ARRIVAL</span><span>최종 목적지</span></div>
      <h3><b>${escapeHtml(finalName)}</b> 도착</h3>
      <button class="map-button" type="button" data-image="${escapeHtml(finalImage)}" data-caption="${escapeHtml(`${finalName} 최종 목적지`)}">
        <img src="${imageUrl(finalImage)}" alt="${escapeHtml(`${finalName} 최종 목적지 지도`)}" loading="lazy" decoding="async">
      </button>
    </article>`);

    const cardCount = cards.length;
    const availableRatio = Math.max(1.35, window.innerWidth / Math.max(500, window.innerHeight - 175));
    const columns = Math.min(cardCount, Math.max(1, Math.ceil(Math.sqrt(cardCount * availableRatio))));
    const rows = Math.max(1, Math.ceil(cardCount / columns));
    elements.content.innerHTML = `<div class="route-panel">
      <div class="route-overview">${overview}</div>
      <div class="route-cards">${cards.join('')}</div>
      <div class="route-footer"><span>경로 ${activeRoute + 1}/${currentRoutes.length}</span><span>${route.edges.length}번 이동 · 이미지 ${cards.length}장</span></div>
    </div>`;
    const routePanel = elements.content.querySelector('.route-panel');
    routePanel.style.setProperty('--route-columns', columns);
    routePanel.style.setProperty('--route-rows', rows);
    const cardGrid = elements.content.querySelector('.route-cards');
    const remainder = cardCount % columns;
    if (remainder) {
      const offset = Math.floor((columns - remainder) / 2);
      for (let index = 0; index < remainder; index++) cardGrid.children[cardCount - remainder + index].style.gridColumnStart = String(offset + index + 1);
    }
    elements.content.querySelectorAll('.map-button').forEach(button => button.addEventListener('click', () => openImage(button.dataset.image, button.dataset.caption)));
  }

  function addFavorite() {
    const start = elements.start.value.trim(); const end = elements.end.value.trim();
    if (!start || !end) return showToast('먼저 출발지와 도착지를 선택해주세요.');
    if (state.bookmarks.some(item => item.start === start && item.end === end)) return showToast('이미 즐겨찾기에 있습니다.');
    state.bookmarks.push({ start, end }); saveState(); renderFavorites(); showToast('즐겨찾기에 추가했습니다.');
  }

  function renderFavorites() {
    if (!state.bookmarks.length) {
      elements.favorites.innerHTML = '<span class="no-favorites">자주 가는 경로를 추가하면 여기에 표시됩니다.</span>';
      return;
    }
    elements.favorites.innerHTML = state.bookmarks.map((bookmark, index) => `<button class="favorite-chip" type="button" data-index="${index}">
      <span>${escapeHtml(bookmark.start)}</span><b>→</b><span>${escapeHtml(bookmark.end)}</span><span class="remove" data-remove="${index}" aria-label="삭제">×</span>
    </button>`).join('');
    elements.favorites.querySelectorAll('.favorite-chip').forEach(button => button.addEventListener('click', event => {
      const remove = event.target.closest('[data-remove]');
      if (remove) {
        event.stopPropagation(); state.bookmarks.splice(Number(remove.dataset.remove), 1); saveState(); renderFavorites(); return;
      }
      const bookmark = state.bookmarks[Number(button.dataset.index)];
      elements.start.value = bookmark.start; elements.end.value = bookmark.end; searchRoutes(true);
    }));
  }

  function openImage(filename, caption) {
    elements.dialogImage.src = imageUrl(filename);
    elements.dialogCaption.textContent = caption;
    elements.dialog.showModal();
  }

  function showToast(message) {
    elements.toast.textContent = message; elements.toast.classList.add('show'); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 2400);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  }

  initialize();
})();
