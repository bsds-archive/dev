/* =====================================================================
   BSDS ARCHIVE — PDF VIEWER SCRIPT
   =====================================================================
   Everything specific to viewer.html lives here — rendering pages,
   search, zoom, touch handling, theme toggle, fullscreen. Loaded
   standalone on viewer.html only (does NOT load js/app.js — this file
   is fully self-contained and has its own tiny _debounce() copy at the
   bottom for that reason).
   ===================================================================== */

/* ---------------------------------------------------------------------
   8. PDF VIEWER (viewer.html)
   -----------------------------------------------------------------
   Renders a PDF using PDF.js (loaded from a CDN by viewer.html, before
   this file). Every page is stacked vertically in one continuously
   scrollable column — like Google Drive's preview — rather than one
   page at a time, so reading feels natural on both a phone (thumb
   scroll) and a desktop (mouse wheel/trackpad).

   Pages render lazily as they scroll near the viewport (via
   IntersectionObserver), not all at once — so a 40-page PDF doesn't
   stall the browser rendering pages nobody's looked at yet. Each
   page's box is still sized correctly up front (from a cheap metadata
   read, not a full render) so the scrollbar never jumps around.

   Alongside each page's canvas, an invisible text layer is built
   (via pdfjsLib.renderTextLayer) — this is what makes in-document
   search possible, and as a bonus lets people actually select/copy
   text out of the PDF, which a plain canvas render can't do.

   Two-finger pinch-to-zoom is left as the browser's normal, native
   page zoom (nothing here calls preventDefault on touch gestures or
   sets touch-action:none) — so pinching zooms the whole page, exactly
   like any other webpage, in addition to the in-app +/- zoom buttons
   which re-render the PDF itself at a new scale.

   Reads two things from the URL query string:
     ?file=<url-encoded relative path to a .pdf under files/>
     ?title=<url-encoded display name>  (optional)

   Call initViewer() once, on DOMContentLoaded, from viewer.html.
--------------------------------------------------------------------- */
let _pdfDoc = null;
let _pdfZoom = 1;              // user-controlled multiplier on top of the auto-fit scale
let _pdfBaseScale = 1;         // scale that makes a page exactly fill the stage width
let _pdfPageMeta = [];         // [{width,height}, ...] natural (scale:1) size of every page
let _pdfTextContentCache = []; // raw PDF.js TextContent object per page (reused for text layer + search)
let _pdfTextIndex = [];        // plain lowercase-searchable string per page, built from the cache above
let _pdfRenderedPages = new Set(); // page numbers already drawn to their canvas
let _pdfRenderObserver = null; // triggers lazy rendering (and unrendering) as pages near/leave the viewport
let _pdfCurrentPage = 1;
let _pdfNavPending = false;   // true while a Prev/Next button's smooth-scroll animation is still settling
let _pdfNavPendingTimer = null;
let _pdfSearchQuery = '';
let _pdfSearchMatchPages = [];      // page numbers containing the current query, in order
let _pdfSearchPageIndex = -1;       // which page, within _pdfSearchMatchPages, we're currently on
let _pdfSearchMarkIndexOnPage = -1; // which occurrence ON that page we're currently on

async function initViewer() {
  const params = new URLSearchParams(window.location.search);
  const fileParam = params.get('file');
  const titleParam = params.get('title');

  const titleEl = document.getElementById('viewerTitle');
  const downloadBtn = document.getElementById('viewerDownload');
  const statusEl = document.getElementById('viewerStatus');
  const pagesEl = document.getElementById('pdfPages');

  if (titleParam && titleEl) titleEl.textContent = titleParam;
  if (fileParam && downloadBtn) {
    downloadBtn.href = fileParam;
    downloadBtn.setAttribute('download', '');
  }

  _updateThemeToggleIcon(); // sync the icon with whatever the early <head> script already applied
  _syncViewerHeaderHeight(); // push PDF content down to clear the fixed header, before anything else loads

  if (!fileParam) {
    _showViewerError('No document was specified in the link.');
    return;
  }
  if (typeof pdfjsLib === 'undefined') {
    _showViewerError('The PDF engine failed to load — check your internet connection and reload.');
    return;
  }

  try {
    const task = pdfjsLib.getDocument(fileParam);
    // shows real download progress for large PDFs — without this, a big
    // file just sits on the spinner with no feedback, which is exactly
    // what reads as "stuck" or "not fetching" on a slower connection
    task.onProgress = (progress) => {
      if (progress.total) {
        const pct = Math.round((progress.loaded / progress.total) * 100);
        _updateLoadingStatus(`Loading document… ${pct}%`);
      }
    };
    _pdfDoc = await task.promise;
  } catch (err) {
    _showViewerError(`
      Couldn't load this PDF at <code>${fileParam}</code>. If this works on a
      local server but not once it's deployed (e.g. on GitHub Pages), the
      most likely causes are:<br><br>
      • <strong>Case sensitivity</strong> — GitHub Pages' server is
      case-sensitive even if your own computer isn't. Double-check the
      "file" path in js/data/semN.js matches the real filename's
      capitalisation exactly.<br>
      • <strong>Git LFS</strong> — if this PDF is large and tracked with
      Git LFS, GitHub Pages can't serve LFS files correctly; it deploys a
      small text pointer instead of the actual PDF. Either keep large
      files under GitHub's 100MB limit without LFS, or host them
      elsewhere (a GitHub Release asset, cloud storage, etc.) and point
      "file" at that URL instead.<br>
      • The file genuinely hasn't been uploaded yet, or the site needs to
      be served through a real server rather than opened directly.
    `);
    return;
  }

  document.getElementById('pageTotal').textContent = _pdfDoc.numPages;

  // Read every page's natural dimensions AND text content up front (cheap —
  // metadata/text extraction only, no actual rendering) so placeholders can
  // be laid out correctly immediately, and search works instantly without
  // waiting for a page to scroll into view first. For a very long document
  // this loop is the main thing worth watching — the progress label below
  // is what tells you it's still working rather than stuck.
  _pdfPageMeta = [];
  _pdfTextContentCache = [];
  _pdfTextIndex = [];
  for (let n = 1; n <= _pdfDoc.numPages; n++) {
    _updateLoadingStatus(`Preparing page ${n} of ${_pdfDoc.numPages}…`);
    const page = await _pdfDoc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    _pdfPageMeta.push({ width: vp.width, height: vp.height });

    const textContent = await page.getTextContent();
    _pdfTextContentCache.push(textContent);
    _pdfTextIndex.push(textContent.items.map((it) => it.str).join(' ').toLowerCase());
  }

  _computeBaseScale();
  _buildPagePlaceholders();
  _setupPageObservers();
  _wireViewerControls();
  _initScrollPageSync();
  _wirePageInput();
  _wireFullscreenButton();
  _initTouchAndZoom();

  if (statusEl) statusEl.hidden = true;
  if (pagesEl) pagesEl.hidden = false;

  // re-fit to width on rotate/resize, keeping the user's zoom multiplier.
  // Guarded to only actually re-fit when the WIDTH changed: mobile browsers
  // fire resize events constantly just from their address bar showing and
  // hiding as you scroll, which changes viewport HEIGHT, never width — but
  // _computeBaseScale() only depends on width. Recomputing (and therefore
  // re-laying-out every page) on every one of those was exactly what made
  // pages visibly shift/misalign mid-scroll on mobile for no real reason.
  let _lastStageWidth = document.getElementById('viewerStage').clientWidth;
  window.addEventListener('resize', _debounce(() => {
    const stage = document.getElementById('viewerStage');
    const widthNow = stage.clientWidth;
    _syncViewerHeaderHeight(); // header height can change (title wraps differently, etc.) — cheap, always safe to redo
    if (widthNow === _lastStageWidth) return; // height-only change (mobile address bar) — nothing to re-fit
    _lastStageWidth = widthNow;
    _computeBaseScale();
    _resizeAllPages();
  }, 200));

  // fonts loading late can shift the header's height by a few px after
  // the very first sync — catch that instead of leaving a small gap/overlap
  window.addEventListener('load', _syncViewerHeaderHeight);
}

// Measures the fixed header/toolbar/search-bar wrapper's real rendered
// height and pushes the PDF stage down to match exactly, so content is
// never hidden underneath it. Called on load, on resize, and whenever
// the search bar opens/closes (since that changes the wrapper's height).
function _syncViewerHeaderHeight() {
  const head = document.getElementById('viewerFixedHead');
  const stage = document.getElementById('viewerStage');
  if (!head || !stage) return;
  const h = head.offsetHeight;
  stage.style.paddingTop = h + 16 + 'px'; // +16 for a little breathing room
}

/* ---- 8c. Custom right-edge scrollbar -----------------------------------
   A real, always-visible drag-to-jump scrubber, like Google Drive's PDF
   preview — native scrollbars are invisible-by-design on mobile and
   inconsistent to style, so this replaces it entirely (the native one is
   hidden via CSS on .viewer-stage). Supports: dragging the thumb, clicking
   anywhere on the track to jump straight there, and a small "Page X / N"
   tooltip while dragging. Uses Pointer Events so the same code handles
   mouse, touch, and pen without separate branches.
--------------------------------------------------------------------------- */
// The toolbar/tooltip's page number normally comes from _pdfCurrentPage,
// which the IntersectionObserver in _setupPageObservers() updates — but
// that update is asynchronous and, on mobile especially, can noticeably
// lag behind a fast scrollbar drag or track click. This computes the
// current page synchronously instead, straight from each page's actual
// on-screen position, so dragging the scrollbar shows the right page
// number immediately rather than one or two pages behind.
function _syncCurrentPageNow() {
  // a Prev/Next button click is still mid-animation (see _scrollToPage) —
  // don't fight it with a transient in-between reading; it'll resume once
  // the animation settles
  if (_pdfNavPending) return;
  if (!_pdfDoc) return;

  // a fixed point 40% down the CURRENT viewport — since the document
  // itself scrolls now (not a nested container), this is simpler than
  // before: no need to account for where .viewer-stage itself sits
  const midline = window.innerHeight * 0.4;

  let current = _pdfCurrentPage;
  document.querySelectorAll('.pdf-page-wrap').forEach((wrap) => {
    const r = wrap.getBoundingClientRect();
    if (r.top <= midline) current = parseInt(wrap.dataset.page, 10);
  });

  _pdfCurrentPage = current;
  _updatePageLabel(current);
}

// Shared by _syncCurrentPageNow() and _scrollToPage() so the toolbar's
// "Page X / N" label and the Prev/Next disabled states are always set the
// same way, from one place.
function _updatePageLabel(n) {
  const pageInput = document.getElementById('pageInput');
  if (pageInput && document.activeElement !== pageInput) pageInput.value = n;
  const prevBtn = document.getElementById('prevPage');
  const nextBtn = document.getElementById('nextPage');
  if (prevBtn) prevBtn.disabled = n <= 1;
  if (nextBtn) nextBtn.disabled = n >= _pdfDoc.numPages;
}

function _wirePageInput() {
  const input = document.getElementById('pageInput');
  if (!input) return;
  function jump() {
    const n = parseInt(input.value, 10);
    if (Number.isFinite(n)) _scrollToPage(n);
    else _updatePageLabel(_pdfCurrentPage);
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); jump(); input.blur(); }
  });
  input.addEventListener('blur', jump);
}

function _initScrollPageSync() {
  let rafPending = false;
  function scheduleUpdate() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { _syncCurrentPageNow(); rafPending = false; });
  }
  window.addEventListener('scroll', scheduleUpdate);
  window.addEventListener('resize', scheduleUpdate);
}

function _showViewerError(message) {
  const statusEl = document.getElementById('viewerStatus');
  if (!statusEl) return;
  statusEl.innerHTML = `<div class="viewer-error">${message}<br><br><a href="javascript:history.back()">← Go back</a></div>`;
}

function _updateLoadingStatus(text) {
  const label = document.getElementById('statusLabel');
  if (label) label.textContent = text;
}

// fit-to-width scale, based on page 1's natural size and the stage's
// current width (capped at a comfortable reading width on wide desktops)
function _computeBaseScale() {
  const stage = document.getElementById('viewerStage');
  const naturalWidth = _pdfPageMeta[0].width;
  const available = Math.min(stage.clientWidth - 32, 900);
  _pdfBaseScale = available / naturalWidth;
}

// creates one placeholder <div class="pdf-page-wrap"> per page, correctly
// sized, each holding an (empty, until rendered) canvas + a page-number badge
function _buildPagePlaceholders() {
  const container = document.getElementById('pdfPages');
  container.innerHTML = '';
  const scale = _pdfBaseScale * _pdfZoom;

  _pdfPageMeta.forEach((meta, idx) => {
    const n = idx + 1;
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page-wrap';
    wrap.dataset.page = n;
    wrap.style.width = Math.floor(meta.width * scale) + 'px';
    wrap.style.height = Math.floor(meta.height * scale) + 'px';
    wrap.innerHTML = `<canvas class="pdf-page-canvas"></canvas><span class="page-badge">${n} / ${_pdfDoc.numPages}</span>`;
    container.appendChild(wrap);
  });

  _pdfRenderedPages = new Set();
}

// re-sizes every placeholder for a new zoom/window-width, and immediately
// re-renders any page that was already drawn (so what's on screen updates)
function _resizeAllPages() {
  const scale = _pdfBaseScale * _pdfZoom;
  document.querySelectorAll('.pdf-page-wrap').forEach((wrap) => {
    const n = parseInt(wrap.dataset.page, 10);
    const meta = _pdfPageMeta[n - 1];
    wrap.style.width = Math.floor(meta.width * scale) + 'px';
    wrap.style.height = Math.floor(meta.height * scale) + 'px';
    if (_pdfRenderedPages.has(n)) {
      _pdfRenderedPages.delete(n);
      _renderSinglePage(n);
    }
  });
  document.getElementById('zoomLabel').textContent = Math.round(_pdfZoom * 100) + '%';
}

// two observers: one with a wide margin that triggers rendering slightly
// before a page is actually visible (so scrolling feels instant), and a
// tighter one purely for updating the "Page X / N" toolbar label
// two observers: one with a wide margin that triggers rendering slightly
// before a page is actually visible (so scrolling feels instant), and a
// tighter one purely for updating the "Page X / N" toolbar label
function _setupPageObservers() {
  if (_pdfRenderObserver) _pdfRenderObserver.disconnect();

  _pdfRenderObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const n = parseInt(entry.target.dataset.page, 10);
      if (entry.isIntersecting) {
        if (!_pdfRenderedPages.has(n)) _renderSinglePage(n);
      } else {
        // well outside the 600px margin below — free this page's canvas
        // and text layer rather than leaving it rendered forever. Without
        // this, a long document just accumulates more and more live
        // canvases and text-layer DOM nodes as you scroll, which is
        // exactly what shows up as scrolling/selection lag over time.
        // The placeholder box stays the correct size either way, so
        // nothing shifts — it just goes blank until scrolled back near.
        _releasePage(n);
      }
    });
  }, { rootMargin: '600px 0px', threshold: 0.01 });

  document.querySelectorAll('.pdf-page-wrap').forEach((el) => _pdfRenderObserver.observe(el));
  // Note: there is deliberately no second "which page is currently
  // visible" observer here anymore — that used to run alongside
  // _syncCurrentPageNow() (used by the scrollbar and button navigation)
  // as a completely separate, asynchronous mechanism computing "current
  // page" with a different heuristic. The two would disagree and race
  // each other, especially during a smooth-scroll animation or a fast
  // scrollbar drag, which is exactly what showed up as the page number
  // flickering/glitching. _syncCurrentPageNow() below is now the single
  // source of truth, run synchronously off the stage's own scroll event.
}

// Frees a rendered page's actual pixel/DOM cost (canvas bitmap + text
// layer spans) once it's scrolled well out of range, without touching
// its placeholder's size — so scroll position and the scrollbar never
// jump. Re-rendered automatically (via _pdfRenderObserver above) the
// moment it scrolls back within range.
function _releasePage(n) {
  if (!_pdfRenderedPages.has(n)) return;
  _pdfRenderedPages.delete(n);

  const wrap = document.querySelector(`.pdf-page-wrap[data-page="${n}"]`);
  if (!wrap) return;

  const canvas = wrap.querySelector('canvas');
  if (canvas) {
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 0;
    canvas.height = 0; // actually releases the backing bitmap's memory, not just visually clearing it
  }
  const textLayer = wrap.querySelector('.pdf-text-layer');
  if (textLayer) textLayer.innerHTML = '';
}

async function _renderSinglePage(n) {
  if (_pdfRenderedPages.has(n)) return;
  _pdfRenderedPages.add(n);

  const wrap = document.querySelector(`.pdf-page-wrap[data-page="${n}"]`);
  if (!wrap) return;
  const canvas = wrap.querySelector('canvas');
  const ctx = canvas.getContext('2d');

  const page = await _pdfDoc.getPage(n);
  const scale = _pdfBaseScale * _pdfZoom;
  const viewport = page.getViewport({ scale });
  // Capped at 2x rather than the raw devicePixelRatio (which is 3 on many
  // phones) — canvas pixel count scales with the SQUARE of this number, so
  // uncapped 3x means roughly double the pixels to paint vs capped 2x, for
  // a difference in sharpness that's barely visible. This was the single
  // biggest contributor to scroll/selection lag on high-DPI phones.
  const outputScale = Math.min(window.devicePixelRatio || 1, 2);

  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
  await page.render({ canvasContext: ctx, viewport, transform }).promise;
  await _renderTextLayer(n, viewport, wrap);
}

// builds the invisible, selectable text layer over a page's canvas — this
// is what real text search + copy/paste rely on, since the canvas itself
// is just pixels PDF.js has no way to search inside of.
async function _renderTextLayer(n, viewport, wrap) {
  let textLayerDiv = wrap.querySelector('.pdf-text-layer');
  if (!textLayerDiv) {
    textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'pdf-text-layer';
    wrap.appendChild(textLayerDiv);
  }
  textLayerDiv.innerHTML = '';
  textLayerDiv.style.width = Math.floor(viewport.width) + 'px';
  textLayerDiv.style.height = Math.floor(viewport.height) + 'px';
  textLayerDiv.style.setProperty('--scale-factor', String(viewport.scale));

  const textContent = _pdfTextContentCache[n - 1];
  await pdfjsLib.renderTextLayer({
    textContentSource: textContent,
    container: textLayerDiv,
    viewport,
    textDivs: [],
  }).promise;

  // if a search is currently active and this page is one of the matches,
  // re-apply its highlights (this runs after every (re)render, including
  // the first time a matched page scrolls into view)
  if (_pdfSearchQuery && _pdfSearchMatchPages.includes(n)) {
    _highlightPage(n, _pdfSearchQuery);
  }
}

function _wireViewerControls() {
  document.getElementById('prevPage').addEventListener('click', () => _scrollToPage(_pdfCurrentPage - 1));
  document.getElementById('nextPage').addEventListener('click', () => _scrollToPage(_pdfCurrentPage + 1));
  document.getElementById('zoomIn').addEventListener('click', () => _setZoom(Math.min(3, _pdfZoom * 1.2)));
  document.getElementById('zoomOut').addEventListener('click', () => _setZoom(Math.max(0.5, _pdfZoom / 1.2)));

  document.addEventListener('keydown', (e) => {
    // don't hijack arrow keys while the person is typing in the search box
    if (document.activeElement && document.activeElement.id === 'searchInput') return;
    if (e.key === 'ArrowRight') _scrollToPage(_pdfCurrentPage + 1);
    if (e.key === 'ArrowLeft') _scrollToPage(_pdfCurrentPage - 1);
  });

  const themeBtn = document.getElementById('themeToggle');
  if (themeBtn) themeBtn.addEventListener('click', toggleViewerTheme);

  const searchToggle = document.getElementById('searchToggle');
  const searchBar = document.getElementById('searchBar');
  const searchInput = document.getElementById('searchInput');
  if (searchToggle && searchBar && searchInput) {
    searchToggle.addEventListener('click', () => {
      searchBar.classList.toggle('open');
      if (searchBar.classList.contains('open')) searchInput.focus();
      else { searchInput.value = ''; _runPdfSearch(''); }
      _syncViewerHeaderHeight(); // the search bar toggling changes the fixed header's total height
    });
    searchInput.addEventListener('input', _debounce(() => _runPdfSearch(searchInput.value), 350));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); _gotoSearchMatch(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { searchInput.value = ''; _runPdfSearch(''); searchBar.classList.remove('open'); _syncViewerHeaderHeight(); }
    });
  }
  const searchPrev = document.getElementById('searchPrev');
  const searchNext = document.getElementById('searchNext');
  if (searchPrev) searchPrev.addEventListener('click', () => _gotoSearchMatch(-1));
  if (searchNext) searchNext.addEventListener('click', () => _gotoSearchMatch(1));
}

// Navigates to page `n` via the Prev/Next toolbar buttons. Updates
// _pdfCurrentPage and the toolbar label IMMEDIATELY — not after the
// smooth-scroll animation finishes — which is what makes clicking
// rapidly advance one page at a time reliably: the old version read
// _pdfCurrentPage fresh on every click, but that value only updated once
// the scroll-driven sync caught up with an in-progress animation, so a
// second click before that happened would re-target the very same page
// instead of the next one. _pdfNavPending then briefly blocks
// _syncCurrentPageNow() from overwriting this with a transient
// mid-animation reading, until the scroll actually settles.
//
// On mobile specifically, that animation's real duration is far less
// predictable than on desktop — touch/momentum scrolling behaves
// differently across browsers, and can easily run longer than a fixed
// guess. Rather than guess a timeout, this listens for the real
// "scrollend" event (fires once a scroll — smooth or otherwise — has
// fully come to rest) where the browser supports it, which is the
// correct way to know rather than assume. A timeout is kept only as a
// fallback for browsers without scrollend support yet, or in case it
// doesn't fire for some reason.
function _scrollToPage(n) {
  n = Math.max(1, Math.min(_pdfDoc.numPages, n));
  const wrap = document.querySelector(`.pdf-page-wrap[data-page="${n}"]`);
  if (!wrap) return;

  wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });

  _pdfCurrentPage = n;
  _updatePageLabel(n);

  _pdfNavPending = true;
  clearTimeout(_pdfNavPendingTimer);

  const release = () => {
    _pdfNavPending = false;
    window.removeEventListener('scrollend', release);
  };

  if ('onscrollend' in window) {
    window.addEventListener('scrollend', release);
    _pdfNavPendingTimer = setTimeout(release, 1500); // generous safety net in case scrollend never fires
  } else {
    _pdfNavPendingTimer = setTimeout(release, 700); // browsers without scrollend support (older Safari)
  }
}

// zooming re-lays-out every page's placeholder size; we capture the
// scroll position as a fraction beforehand and restore it after, so the
// reader doesn't lose their place when the page stack's height changes
function _setZoom(newZoom) {
  const doc = document.documentElement;
  const maxScroll = Math.max(1, doc.scrollHeight - window.innerHeight);
  const scrollFraction = window.scrollY / maxScroll;

  _pdfZoom = newZoom;
  _resizeAllPages();

  requestAnimationFrame(() => {
    const newMaxScroll = Math.max(1, doc.scrollHeight - window.innerHeight);
    window.scrollTo(0, scrollFraction * newMaxScroll);
  });
}

/* ---- 8b1. Custom touch scrolling + pinch-zoom + trackpad zoom ----------
   Native browser zoom can't be reliably disabled from a webpage — mobile
   browsers ignore the viewport meta restriction for accessibility
   reasons (iOS explicitly, others may too), and desktop browsers never
   honored it in the first place; there's no web standard for a page to
   block the user's own zoom controls. So instead of trying to prevent
   native zoom and hoping panning still works afterward (which is what
   kept failing), this takes over the input entirely: touch-action:none
   on .viewer-stage (set in css/viewer.css) tells the browser not to
   handle ANY touch gesture there natively, and everything below —
   single-finger scrolling, two-finger pinch-zoom, and desktop trackpad-
   pinch/Ctrl+scroll-zoom — is implemented here instead, all funneling
   into the exact same _setZoom() the +/- toolbar buttons already use
   (which is known to scroll correctly in both directions, since it
   never touched native zoom to begin with).

   Trade-off, to be upfront about it: this means scrolling no longer has
   the OS's native momentum/inertia after you lift your finger — it's
   direct 1:1 finger tracking instead. Less smooth, but reliable, which
   given how long native zoom fighting took to (not) work, is the right
   call here.
--------------------------------------------------------------------------- */
function _initTouchAndZoom() {
  const stage = document.getElementById('viewerStage');
  if (!stage) return;

  const pointers = new Map(); // pointerId -> {x, y} — every currently-active finger
  let pinchStartDistance = null;
  let pinchStartZoom = 1;
  let panLast = null; // {x,y} of the single active finger, for computing scroll delta frame-to-frame

  const distanceBetween = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  let zoomRafPending = false;
  let pendingZoom = null;
  function scheduleZoom(z) {
    pendingZoom = z;
    if (zoomRafPending) return;
    zoomRafPending = true;
    requestAnimationFrame(() => {
      if (pendingZoom !== null) _setZoom(pendingZoom);
      zoomRafPending = false;
    });
  }

  // --- touch: one finger pans, two fingers pinch-zoom ---
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return; // mouse uses the wheel handler below, not this
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      panLast = { x: e.clientX, y: e.clientY };
    } else if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      pinchStartDistance = distanceBetween(a, b);
      pinchStartZoom = _pdfZoom;
      panLast = null; // a second finger joining mid-pan switches modes to pinch
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2 && pinchStartDistance) {
      e.preventDefault();
      const [a, b] = Array.from(pointers.values());
      const ratio = distanceBetween(a, b) / pinchStartDistance;
      scheduleZoom(Math.min(3, Math.max(0.5, pinchStartZoom * ratio)));
    } else if (pointers.size === 1 && panLast) {
      e.preventDefault();
      const dx = e.clientX - panLast.x;
      const dy = e.clientY - panLast.y;
      window.scrollBy(-dx, -dy); // dragging down/right reveals content above/left, same as any touch scroll
      panLast = { x: e.clientX, y: e.clientY };
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStartDistance = null;
    if (pointers.size === 1) {
      panLast = { ...Array.from(pointers.values())[0] }; // resume single-finger panning with whichever finger is left
    } else if (pointers.size === 0) {
      panLast = null;
    }
  }
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((evt) => stage.addEventListener(evt, endPointer));

  // --- desktop: Ctrl+scroll-wheel and trackpad-pinch (browsers report
  // both as a wheel event with ctrlKey set — there's no separate
  // trackpad-gesture API in most browsers, this IS how it arrives) ---
  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return; // a plain (non-ctrl) wheel scroll is normal mouse-wheel scrolling — leave it alone, untouched
    e.preventDefault();
    const newZoom = Math.min(3, Math.max(0.5, _pdfZoom * (1 - e.deltaY * 0.01)));
    scheduleZoom(newZoom);
  }, { passive: false }); // passive:false is required for preventDefault() to actually take effect on a wheel event
}

/* ---- 8a. In-document search ------------------------------------------
   Scans the pre-built _pdfTextIndex (no network/render needed) to find
   which pages contain the query, force-renders those specific pages if
   they haven't been drawn yet (so highlights have something to attach
   to), then highlights every match and lets Enter / the arrow buttons
   step through them.
------------------------------------------------------------------------ */
async function _runPdfSearch(query) {
  _clearAllHighlights();
  query = query.trim();
  _pdfSearchQuery = query;
  const resultsLabel = document.getElementById('searchResults');
  _pdfSearchMatchPages = [];
  _pdfSearchPageIndex = -1;
  _pdfSearchMarkIndexOnPage = -1;

  if (!query) {
    if (resultsLabel) resultsLabel.textContent = '';
    return;
  }

  // Everything here reads only the pre-cached _pdfTextIndex — no
  // rendering happens yet. Rendering (and highlighting) every matching
  // page up front used to be exactly what made searching a long document
  // feel slow: a common word can match most of the document, which meant
  // rendering nearly the whole thing just to show a result count.
  const q = query.toLowerCase();
  let totalOccurrences = 0;
  _pdfTextIndex.forEach((text, idx) => {
    let count = 0, pos = 0;
    while ((pos = text.indexOf(q, pos)) !== -1) { count++; pos += q.length; }
    if (count > 0) { _pdfSearchMatchPages.push(idx + 1); totalOccurrences += count; }
  });

  if (!_pdfSearchMatchPages.length) {
    if (resultsLabel) resultsLabel.textContent = 'No matches';
    return;
  }

  if (resultsLabel) resultsLabel.textContent = `${totalOccurrences} match${totalOccurrences === 1 ? '' : 'es'}`;
  _gotoSearchMatch(1); // renders + highlights only this one page, lazily
}

// Wraps every occurrence of `query` inside a page's (already-rendered)
// text layer in a <mark>. This works ACROSS span boundaries, not just
// within a single one — PDF text is broken into a new span at every
// font/kerning change, not at word boundaries, so a match can easily
// straddle two (or more) spans. Matching only within individual spans
// (the simpler approach) silently misses those, which is exactly what
// caused only one occurrence per page to ever get highlighted: whichever
// one happened to land cleanly inside a single span, while the others —
// still real, still found by the page-level search — were invisible.
function _highlightPage(n, query) {
  const wrap = document.querySelector(`.pdf-page-wrap[data-page="${n}"]`);
  const textLayer = wrap && wrap.querySelector('.pdf-text-layer');
  if (!textLayer || !query) return;
  const q = query.toLowerCase();

  const spans = Array.from(textLayer.querySelectorAll('span'));
  if (!spans.length) return;
  const originals = spans.map((s) => s.textContent);

  // one combined string across every span, joined the same way
  // _pdfTextIndex was (single space between items) — keeps this in sync
  // with how pages get *found* in the first place, and with a matching
  // character-position map so a match's range can be traced back to
  // exactly which span(s) it touches
  const combined = originals.join(' ').toLowerCase();
  const charMap = []; // charMap[i] = {spanIdx, offset} | null (a joining space)
  originals.forEach((text, spanIdx) => {
    for (let i = 0; i < text.length; i++) charMap.push({ spanIdx, offset: i });
    charMap.push(null);
  });

  const ranges = [];
  let pos = 0;
  while (true) {
    const found = combined.indexOf(q, pos);
    if (found === -1) break;
    ranges.push([found, found + q.length]);
    pos = found + q.length;
  }
  if (!ranges.length) return;

  // group each match's characters by which span they land in, collapsing
  // consecutive same-span characters into single runs — a match entirely
  // within one span becomes one run; one straddling a boundary becomes
  // two (or more) runs, each highlighted separately but sitting right
  // next to each other so they still read as one continuous highlight
  const bySpan = new Map();
  ranges.forEach(([start, end]) => {
    for (let i = start; i < end; i++) {
      const c = charMap[i];
      if (!c) continue;
      if (!bySpan.has(c.spanIdx)) bySpan.set(c.spanIdx, []);
      const runs = bySpan.get(c.spanIdx);
      const last = runs[runs.length - 1];
      if (last && last[1] === c.offset) last[1] = c.offset + 1;
      else runs.push([c.offset, c.offset + 1]);
    }
  });

  bySpan.forEach((runs, spanIdx) => {
    const span = spans[spanIdx];
    const text = originals[spanIdx];
    let html = '';
    let cursor = 0;
    runs.forEach(([start, end]) => {
      html += text.slice(cursor, start);
      html += `<mark class="pdf-search-mark">${text.slice(start, end)}</mark>`;
      cursor = end;
    });
    html += text.slice(cursor);
    span.innerHTML = html;
  });
}

function _clearAllHighlights() {
  document.querySelectorAll('.pdf-search-mark').forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
}

// Steps to the next/previous individual highlighted occurrence — every
// match on the current page first, only moving to the next/previous
// matching PAGE once those are exhausted. This is deliberately NOT
// "render every matching page up front and flatten them into one list":
// that was the old approach, and for a common word matching most of a
// long document, it meant rendering nearly the whole thing just to
// search. Instead, only the page actually being visited ever gets
// rendered — one page at a time, lazily — while still visiting every
// occurrence on it before moving on, not skipping straight to the next
// page's first match.
async function _gotoSearchMatch(step) {
  if (!_pdfSearchMatchPages.length) return;

  // first call after a fresh search — start on the first page
  if (_pdfSearchPageIndex === -1) {
    _pdfSearchPageIndex = 0;
    await _renderSinglePage(_pdfSearchMatchPages[_pdfSearchPageIndex]);
    _highlightPage(_pdfSearchMatchPages[_pdfSearchPageIndex], _pdfSearchQuery);
    _pdfSearchMarkIndexOnPage = step >= 0 ? -1 : _currentPageMarks().length; // so the step below lands on the first/last mark
  }

  let marks = _currentPageMarks();
  let nextIndex = _pdfSearchMarkIndexOnPage + step;

  // ran off either end of the current page's matches — move to the
  // next/previous matching page (wrapping around the whole document),
  // render + highlight it, then land on its first/last match
  if (nextIndex < 0 || nextIndex >= marks.length) {
    _pdfSearchPageIndex = (_pdfSearchPageIndex + step + _pdfSearchMatchPages.length) % _pdfSearchMatchPages.length;
    const n = _pdfSearchMatchPages[_pdfSearchPageIndex];
    await _renderSinglePage(n);
    _highlightPage(n, _pdfSearchQuery);
    marks = _currentPageMarks();
    nextIndex = step >= 0 ? 0 : marks.length - 1;
  }

  _pdfSearchMarkIndexOnPage = nextIndex;

  document.querySelectorAll('.pdf-search-mark.active').forEach((m) => m.classList.remove('active'));
  const target = marks[_pdfSearchMarkIndexOnPage];
  if (target) {
    target.classList.add('active');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// all highlighted marks on the page we're currently stepping through,
// in reading order
function _currentPageMarks() {
  const n = _pdfSearchMatchPages[_pdfSearchPageIndex];
  const wrap = document.querySelector(`.pdf-page-wrap[data-page="${n}"]`);
  return wrap ? Array.from(wrap.querySelectorAll('.pdf-search-mark')) : [];
}

/* ---- 8b. Light / dark theme (viewer only) -----------------------------
   Flips a data-theme attribute on <html>, which css/viewer.css uses to
   swap the design tokens (see the `html[data-theme="light"]` block in
   that file). Persisted to localStorage; viewer.html has a tiny inline
   script in <head> that applies the saved preference before first paint
   so there's no flash of the wrong theme.
------------------------------------------------------------------------ */
function toggleViewerTheme() {
  const html = document.documentElement;
  const goingLight = html.getAttribute('data-theme') !== 'light';
  if (goingLight) html.setAttribute('data-theme', 'light');
  else html.removeAttribute('data-theme');
  try { localStorage.setItem('bsds-viewer-theme', goingLight ? 'light' : 'dark'); } catch (e) { /* private browsing, etc — safe to ignore */ }
  _updateThemeToggleIcon();
}

function _updateThemeToggleIcon() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const label = isLight ? 'Switch to dark mode' : 'Switch to light mode';
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
  btn.innerHTML = isLight
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
}

/* ---- 8c. Fullscreen toggle ---------------------------------------------
   Plain Fullscreen API. Note that iOS Safari doesn't support it at all
   (only for <video> elements) — rather than show a button that silently
   does nothing there, the button hides itself when the API isn't there.
--------------------------------------------------------------------------- */
function _wireFullscreenButton() {
  const btn = document.getElementById('fullscreenToggle');
  if (!btn) return;

  const supported = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
  if (!supported) { btn.style.display = 'none'; return; }

  btn.addEventListener('click', () => {
    const isFull = document.fullscreenElement || document.webkitFullscreenElement;
    if (!isFull) {
      const request = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
      request.call(document.documentElement).catch(() => {});
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      exit.call(document).catch(() => {});
    }
  });

  document.addEventListener('fullscreenchange', _onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', _onFullscreenChange);
  _updateFullscreenIcon();
}

function _onFullscreenChange() {
  _updateFullscreenIcon();
  // entering/exiting fullscreen changes the viewport size (browser chrome
  // appears/disappears), so the header height and the PDF's fit-to-width
  // scale both need recomputing, same as a window resize would trigger
  _syncViewerHeaderHeight();
  _computeBaseScale();
  _resizeAllPages();
}

function _updateFullscreenIcon() {
  const btn = document.getElementById('fullscreenToggle');
  if (!btn) return;
  const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
  const label = isFull ? 'Exit fullscreen' : 'Enter fullscreen';
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
  btn.innerHTML = isFull
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3H5a2 2 0 00-2 2v4M15 3h4a2 2 0 012 2v4M9 21H5a2 2 0 01-2-2v-4M15 21h4a2 2 0 002-2v-4"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V5a2 2 0 012-2h4M20 9V5a2 2 0 00-2-2h-4M4 15v4a2 2 0 002 2h4M20 15v4a2 2 0 01-2 2h-4"/></svg>`;
}

function _debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
