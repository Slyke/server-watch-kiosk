<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Diagnostics from './Diagnostics.svelte';
  import { type ServiceView, type Snapshot, type Theme, states, themes } from '../shared/contracts.js';
  import { automaticPane, currentServices, sortedServices, moveService, type Pane } from './state.js';
  import { preferences, savePreferences, type Preferences } from './preferences.js';
  import t from './i18n/en-US.json';
  import { screenWakeLock, type WakeState } from './wake-lock.js';
  import { SnapshotSchema } from '../shared/snapshot-schema.js';
  import { localTimestamp } from './time.js';
  import { apiFetch, readUnlockCode, saveUnlockCode, forgetUnlockCode, unlockStorageKey } from './api.js';
  import { displaySettingsKeys, type DisplaySettings, type DisplaySettingsState } from '../shared/display-settings.js';
  let wake = $state<ReturnType<typeof screenWakeLock> | null>(null);
  let wakeState = $state<WakeState>('off');
  let snapshot = $state<Snapshot | null>(null);
  let receivedAt = $state(0); let clock = $state(0); let connected = $state(false); let initialError = $state('');
  let prefs = $state<Preferences | null>(null); let pane = $state<Pane>({ owner: 'closed', selected: null, tracked: [] });
  let modalId = $state<string | null>(null); let dialog: HTMLDialogElement;
  let optionsOpen = $state(false); let layoutOpen = $state(false); let layoutName = $state(''); let layoutMessage = $state('');
  let runtime = $state<{ watching: boolean; modules: { type: string; state: string; reason?: string }[]; scenario?: string; version?: string; buildHash?: string } | null>(null);
  let runtimeMessage = $state(''); let runtimeBusy = $state(false); let pollingPaused = $state(false);
  let width = $state(1920); let dragging = $state(false); let dragId = ''; let workspace: HTMLDivElement;
  let statusController: AbortController | undefined; let pollTimer: ReturnType<typeof setTimeout> | undefined; let alive = true;
  let backdropDown = false;
  let kiosk = $state(false);
  let unlockAvailable = $state(false); let unlockedWithCode = $state(false);
  let statusOnly = $state(true);
  let displayedSettings: DisplaySettings | null = null; let settingsRevision = -1; let settingsInstance = '';
  let settingsPending = 0; let settingsQueue = Promise.resolve();
  let unlockOpen = $state(false); let unlockDraft = $state(''); let unlockMessage = $state(''); let unlockBusy = $state(false);
  let pixelShift = $state({ x: 0, y: 0 });
  const icons: Record<string, string> = { healthy: '■', warning: '▲', critical: '×', unknown: '?', paused: 'Ⅱ' };
  const storage = () => { try { return localStorage; } catch { return undefined; } };
  const services = $derived(snapshot ? currentServices({ snapshot, elapsed: Math.max(0, clock - receivedAt), connected }) : []);
  const sorted = $derived(sortedServices({ services, mode: prefs?.sortMode ?? 'severity', order: prefs?.customOrders[prefs.customOrder] ?? [] }));
  const selected = $derived(services.find(s => s.id === pane.selected));
  const modalService = $derived(services.find(s => s.id === modalId));
  const failures = $derived(sortedServices({ services: services.filter(s => s.state === 'critical' && s.fresh && s.confirmed), mode: 'severity' }));
  const paneOpen = $derived(pane.owner !== 'closed');
  const diagnosticsEnabled = $derived(Boolean(snapshot && snapshot.ui.diagnosticsEnabled !== false));
  const narrow = $derived(width < 680);
  const split = $derived(Math.min(Math.max(prefs?.splitRatio ?? 0.6, 280 / Math.max(1, width - 8)), 1 - 320 / Math.max(1, width - 8)));
  const applySharedSettings = (state: DisplaySettingsState) => {
    if (!prefs) return;
    prefs = { ...prefs, ...state.value };
    displayedSettings = structuredClone(state.value); settingsRevision = state.revision;
    savePreferences({ value: prefs, storage: storage() });
  };
  const persist = () => {
    if (!prefs) return;
    savePreferences({ value: prefs, storage: storage() });
    if (statusOnly || !snapshot?.ui.optionsEnabled || !displayedSettings) return;
    const next = Object.fromEntries(displaySettingsKeys.map(key => [key, prefs![key]])) as DisplaySettings;
    const patch = Object.fromEntries(displaySettingsKeys.filter(key => JSON.stringify(next[key]) !== JSON.stringify(displayedSettings![key])).map(key => [key, next[key]]));
    if (!Object.keys(patch).length) return;
    displayedSettings = JSON.parse(JSON.stringify(next));
    const body = JSON.stringify(patch); settingsPending++;
    settingsQueue = settingsQueue.then(async () => {
      try {
        const response = await apiFetch('/api/v1/preferences', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Settings update failed');
        const state: DisplaySettingsState = await response.json();
        if (settingsPending === 1) { applySharedSettings(state); runtimeMessage = ''; }
      } catch {
        settingsRevision = -1;
        runtimeMessage = 'Display settings could not be saved. Try again.'; layoutMessage = runtimeMessage;
      } finally { settingsPending--; }
    });
  };
  const manual = () => { if (paneOpen) { pane = { ...pane, owner: 'manual' }; if (prefs) { prefs.manualPaneOpen = true; persist(); } } };
  const refresh = async () => {
    if (pollingPaused) return;
    statusController?.abort(); statusController = new AbortController(); const own = statusController; const started = performance.now();
    try {
      const attemptedCode = readUnlockCode();
      let response = await apiFetch('/api/v1/status', { signal: AbortSignal.any([own.signal, AbortSignal.timeout(10000)]) }, attemptedCode);
      if (response.status === 401) {
        if (readUnlockCode() === attemptedCode) forgetUnlockCode();
        clearFullUi();
        response = await apiFetch('/api/v1/status', { signal: AbortSignal.any([own.signal, AbortSignal.timeout(10000)]) });
      }
      if (!response.ok) throw new Error('Status service unavailable');
      const value: Snapshot = SnapshotSchema.parse(await response.json());
      if (!alive || own.signal.aborted || (snapshot?.instanceId === value.instanceId && value.revision <= snapshot.revision)) return;
      snapshot = value; receivedAt = started; clock = performance.now(); connected = true; initialError = '';
      unlockAvailable = response.headers.get('x-service-board-unlock-available') === 'true';
      unlockedWithCode = response.headers.get('x-service-board-access') === 'code';
      statusOnly = response.headers.get('x-service-board-access') === 'status-only';
      document.documentElement.dataset.font = 'system-stack';
      if (!prefs) {
        prefs = preferences({ defaults: value.ui, storage: storage() });
        if (prefs.manualPaneOpen && value.ui.diagnosticsEnabled !== false) pane = { owner: 'manual', selected: sortedServices({ services: value.services, mode: 'severity' })[0]?.id ?? null, tracked: [] };
      }
      if (value.ui.sharedPreferences && !settingsPending && (settingsInstance !== value.instanceId || settingsRevision !== value.ui.sharedPreferences.revision)) {
        settingsInstance = value.instanceId; applySharedSettings(value.ui.sharedPreferences);
      }
    } catch { if (!own.signal.aborted && alive) { connected = false; initialError = 'Unable to reach the board. Retrying automatically…'; } }
  };
  const schedulePoll = async () => {
    await refresh();
    if (alive) pollTimer = setTimeout(() => { void schedulePoll(); }, Math.max(1000, snapshot?.pollMs ?? 5000));
  };
  onMount(() => {
    kiosk = new URLSearchParams(window.location.search).get('kiosk') === '1';
    const shiftTimer = setInterval(() => {
      if (kiosk && !modalId && !optionsOpen && !layoutOpen && !dragging) {
        const step = Math.floor(Date.now() / 60000) % 8;
        pixelShift = { x: [-4, 0, 4, 4, 4, 0, -4, -4][step]!, y: [-4, -4, -4, 0, 4, 4, 4, 0][step]! };
      }
    }, 60000);
    wake = screenWakeLock({ onState: state => { wakeState = state; } });
    alive = true; width = window.innerWidth; clock = performance.now();
    void schedulePoll();
    const syncAccess = (event: StorageEvent) => {
      if (event.key === unlockStorageKey || event.key === null) { clearFullUi(); void refresh(); }
    };
    window.addEventListener('storage', syncAccess);
    const ticker = setInterval(() => { clock = performance.now(); }, 1000);
    return () => { wake?.destroy(); alive = false; clearTimeout(pollTimer); clearInterval(ticker); clearInterval(shiftTimer); statusController?.abort(); window.removeEventListener('storage', syncAccess); };
  });
  $effect(() => { wake?.setEnabled({ value: Boolean(prefs?.keepAwake && snapshot?.mode === 'live') }); });
  $effect(() => {
    if (snapshot) document.documentElement.dataset.theme = prefs?.themeOverride ?? snapshot.ui.theme;
  });
  $effect(() => {
    if (!prefs) return;
    if (!diagnosticsEnabled) { pane = { owner: 'closed', selected: null, tracked: [] }; modalId = null; return; }
    const next = automaticPane({ pane, services, enabled: prefs.autoDiagnostics });
    if (JSON.stringify(next) !== JSON.stringify(pane)) pane = next;
  });
  $effect(() => {
    if (!dialog) return;
    if (modalId && modalService && !dialog.open) dialog.showModal();
    if ((!modalId || !modalService) && dialog.open) dialog.close();
  });
  const openService = async (service: ServiceView) => {
    if (!diagnosticsEnabled) return;
    if (paneOpen) { pane = { owner: 'manual', selected: service.id, tracked: [] }; manual(); }
    else { modalId = service.id; await tick(); if (!dialog?.open) dialog?.showModal(); }
  };
  const closeModal = () => {
    const origin = modalId; modalId = null; dialog?.close();
    if (origin) document.getElementById('tile-' + origin)?.focus();
  };
  const modalKeys = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || !dialog?.open) return;
    const controls = [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')].filter(el => el.tabIndex >= 0 && !el.hasAttribute('disabled') && el.getClientRects().length > 0);
    const first = controls[0]; const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  };
  const outsideDialog = (event: MouseEvent | PointerEvent) => {
    const bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  };
  const closePane = () => {
    pane = { ...pane, owner: 'closed', tracked: [] };
    if (prefs) { prefs.autoDiagnostics = false; prefs.manualPaneOpen = false; persist(); }
  };
  const togglePane = () => {
    if (!diagnosticsEnabled) return;
    if (paneOpen) { closePane(); return; }
    pane = { owner: 'manual', selected: selected?.id ?? failures[0]?.id ?? sorted[0]?.id ?? null, tracked: [] };
    if (prefs) { prefs.manualPaneOpen = true; persist(); }
    if (modalId) closeModal();
  };
  const toggleAuto = () => {
    if (!prefs) return;
    if (prefs.autoDiagnostics) { prefs.manualPaneOpen = false; pane = { ...pane, owner: 'closed', tracked: [] }; }
    persist();
  };
  const resizeMove = (event: PointerEvent) => {
    if (!dragging || !workspace || !prefs) return;
    const rect = workspace.getBoundingClientRect(); prefs.splitRatio = Math.min(0.8, Math.max(0.2, (event.clientX - rect.left) / rect.width));
  };
  const resizeEnd = () => { if (dragging) { dragging = false; persist(); } };
  const resizeKey = (event: KeyboardEvent) => {
    if (!prefs || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    prefs.splitRatio = event.key === 'Home' ? 0.2 : (event.key === 'End' ? 0.8 : Math.min(0.8, Math.max(0.2, prefs.splitRatio + (event.key === 'ArrowRight' ? 0.03 : -0.03))));
    persist();
  };
  const changeSort = () => {
    if (prefs?.sortMode === 'custom' && !Object.keys(prefs.customOrders).length) {
      prefs.customOrders['My layout'] = sortedServices({ services, mode: 'severity' }).map(s => s.id); prefs.customOrder = 'My layout';
    }
    persist();
  };
  const showLayout = () => { layoutOpen = !layoutOpen; optionsOpen = false; layoutName = prefs?.customOrder ?? ''; layoutMessage = ''; };
  const saveLayout = (rename = false) => {
    if (!prefs) return;
    const name = layoutName.trim();
    if (!name || name.length > 64 || ['__proto__', 'constructor', 'prototype'].includes(name)) { layoutMessage = 'Enter a name of 1–64 characters.'; return; }
    if (Object.hasOwn(prefs.customOrders, name) && (!rename || name !== prefs.customOrder)) { layoutMessage = 'That name is already in use.'; return; }
    if (!rename && Object.keys(prefs.customOrders).length >= 30) { layoutMessage = 'Maximum 30 saved layouts.'; return; }
    const ids = sorted.map(s => s.id);
    if (rename) delete prefs.customOrders[prefs.customOrder];
    prefs.customOrders[name] = ids; prefs.customOrder = name; prefs.sortMode = 'custom'; layoutMessage = 'Layout saved.'; persist();
  };
  const deleteLayout = () => {
    if (!prefs) return; delete prefs.customOrders[prefs.customOrder];
    prefs.customOrder = Object.keys(prefs.customOrders)[0] ?? ''; layoutName = prefs.customOrder;
    if (!prefs.customOrder) prefs.sortMode = 'severity'; persist();
  };
  const reorder = ({ id, before }: { id: string; before: string }) => {
    if (!prefs || prefs.sortMode !== 'custom' || !prefs.customOrder) return;
    prefs.customOrders[prefs.customOrder] = moveService({ ids: sorted.map(s => s.id), id, before }); persist();
  };
  const step = (id: string, delta: number) => {
    if (!prefs) return;
    const ids = sorted.map(s => s.id); const index = ids.indexOf(id); const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!]; prefs.customOrders[prefs.customOrder] = ids; persist();
  };
  const loadRuntime = async () => {
    try { const response = await apiFetch('/api/v1/runtime'); if (response.ok) runtime = await response.json(); }
    catch { runtimeMessage = 'Runtime options unavailable.'; }
  };
  const showOptions = () => { optionsOpen = !optionsOpen; layoutOpen = false; if (optionsOpen) void loadRuntime(); };
  const runtimeAction = async (action: Record<string, unknown>) => {
    runtimeBusy = true; runtimeMessage = '';
    try {
      const response = await apiFetch('/api/v1/runtime', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Runtime action failed');
      runtimeMessage = result.errors && Object.keys(result.errors).length ? 'Some modules could not reload. See module status below.' : 'Applied.';
      await loadRuntime(); await refresh();
    } catch (error) { runtimeMessage = error instanceof Error ? error.message : 'Runtime action unavailable'; }
    finally { runtimeBusy = false; }
  };
  const fullscreen = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { runtimeMessage = 'Full screen is unavailable in this browser.'; }
  };
  const clearFullUi = () => {
    dialog?.close(); modalId = null; pane = { owner: 'closed', selected: null, tracked: [] };
    optionsOpen = false; layoutOpen = false; runtime = null; runtimeMessage = '';
    snapshot = null; unlockedWithCode = false; pollingPaused = false;
  };
  const showUnlock = async () => {
    unlockOpen = true; unlockDraft = ''; unlockMessage = '';
    await tick(); document.getElementById('unlock-code')?.focus();
  };
  const unlockUi = async () => {
    const code = unlockDraft.trim();
    if (!/^[!-~]{1,512}$/.test(code)) { unlockMessage = 'Enter a valid unlock code.'; return; }
    unlockBusy = true; unlockMessage = '';
    try {
      const response = await apiFetch('/api/v1/access', { signal: AbortSignal.timeout(10000) }, code);
      if (response.status === 401) { unlockMessage = 'Incorrect unlock code.'; return; }
      if (!response.ok || !(await response.json()).unlockedWithCode) throw new Error('Unlock unavailable');
      try { saveUnlockCode(code); }
      catch { unlockMessage = 'Allow browser storage to remember the unlock code.'; return; }
      unlockDraft = ''; unlockOpen = false; pollingPaused = false;
      await refresh();
    } catch { unlockMessage = 'Unable to unlock the board. Try again.'; }
    finally { unlockBusy = false; }
  };
  const lockUi = async () => {
    forgetUnlockCode(); clearFullUi(); await refresh();
  };
  const cardStyle = (service: ServiceView) => {
    const p = service.presentation;
    return p ? [p.background ? '--card-bg:' + p.background : '', p.foreground ? '--card-text:' + p.foreground : '', p.border ? '--card-border:' + p.border : ''].filter(Boolean).join(';') : '';
  };
</script>

<svelte:window onresize={() => { width = window.innerWidth; }} onpointermove={resizeMove} onpointerup={resizeEnd} onkeydown={(e) => { if (e.key === 'Escape' && !modalId) { optionsOpen = false; layoutOpen = false; } }} />
<div class="app-shell" class:kiosk style:transform={kiosk ? `translate(${pixelShift.x}px, ${pixelShift.y}px)` : undefined}>
  <header class="toolbar">
    <div class="legend" aria-label="Service health legend">
      {#each states as state}<span data-state={state}><span class="state-icon">{icons[state]}</span> {t['board-' + state as keyof typeof t]}</span>{/each}
    </div>
    {#if snapshot?.mode === 'demo'}<span class="demo-badge" title={t['board-simulated']}>{t['board-demo']}</span>{/if}
    <span class:disconnected={!connected} class="refresh-age" role="status">{snapshot ? (connected ? t['board-last-refresh'] + ' ' + Math.max(0, Math.floor((clock - receivedAt) / 1000)) + 's ago' : 'Disconnected') : 'Connecting…'}</span>
    <div class="toolbar-actions">
      {#if prefs}
        <label class="sort-control"><span class="sr-only">{t['board-sort-label']}</span><select disabled={statusOnly} aria-label={t['board-sort-label']} bind:value={prefs.sortMode} onchange={changeSort}><option value="severity">{t['board-sort-severity']}</option><option value="name">{t['board-sort-name']}</option><option value="custom">{t['board-sort-custom']}</option></select></label>
        {#if prefs.sortMode === 'custom'}
          <select disabled={statusOnly} class="layout-select" aria-label="Custom layout" bind:value={prefs.customOrder} onchange={persist}>{#each Object.keys(prefs.customOrders) as name}<option value={name}>{name}</option>{/each}</select>
          {#if !statusOnly}<button onclick={showLayout} aria-expanded={layoutOpen}>{t['board-layout-edit']}</button>{/if}
        {/if}
        {#if diagnosticsEnabled}<label class="check-label auto-control"><input disabled={statusOnly} type="checkbox" bind:checked={prefs.autoDiagnostics} onchange={toggleAuto}>{t['board-auto']}</label>{/if}
      {/if}
      {#if diagnosticsEnabled}<button onclick={togglePane} aria-pressed={paneOpen}>{t['board-diagnostics']}</button>{/if}
      {#if snapshot && statusOnly}<span class="muted">Read-only status</span>{/if}
      <button onclick={() => { void fullscreen(); }}>{t['board-fullscreen']}</button>
      {#if snapshot?.ui.optionsEnabled}<button onclick={showOptions} aria-expanded={optionsOpen}>{t['board-options']}</button>{/if}
      {#if unlockAvailable && statusOnly}<button onclick={() => { void showUnlock(); }}>Unlock</button>{/if}
      {#if unlockedWithCode}<button onclick={() => { void lockUi(); }}>Lock UI</button>{/if}
    </div>
  </header>
  {#if !connected && snapshot}<div class="connection-banner" role="status">{t['board-connection-lost']}</div>{/if}
  {#if !snapshot}<div class="initial-state" role="status">{initialError || 'Connecting to Service Board…'}</div>{/if}
  <div class:resizing={dragging} class="workspace" bind:this={workspace}>
    <main class:hidden-on-mobile={paneOpen && narrow} class="board-wrap" style:width={paneOpen && !narrow ? 'calc((100% - 8px) * ' + split + ')' : '100%'} aria-label="Service board">
      <div class:dense={prefs?.dense} class="board">
        {#each sorted as service (service.id)}
          <button class="tile" id={'tile-' + service.id} data-service={service.id} data-state={service.state}
            class:selected={pane.selected === service.id && paneOpen} class:text-wrap={service.presentation?.textMode === 'wrap'}
            class:long-title={service.name.length > 30}
            style={cardStyle(service)} aria-label={service.name + ' · ' + t['board-' + service.state as keyof typeof t] + ' · ' + service.reason}
            title={service.reason} draggable={!statusOnly && prefs?.sortMode === 'custom'}
            ondragstart={(event) => { dragId = service.id; event.dataTransfer?.setData('text/plain', service.id); }}
            ondragover={(event) => { if (prefs?.sortMode === 'custom') event.preventDefault(); }}
            ondrop={(event) => { event.preventDefault(); reorder({ id: dragId, before: service.id }); }}
            onclick={() => { void openService(service); }}>
            <div class="tile-heading">
              <strong class="tile-name" title={service.presentation?.title ?? service.name}>{service.presentation?.title ?? service.name}</strong>
              {#if service.presentation?.icon}<span class="tile-icon" aria-hidden="true">{service.presentation.icon}</span>{/if}
            </div>
            <span class="tile-group">{service.group}</span>
            <div class="tile-body">
              <p>{service.presentation?.text ?? service.reason}</p>
              {#if service.presentation?.timestamp}
                <p class="change-time">{service.presentation.timestamp.label}: {#if service.presentation.timestamp.at}<time datetime={service.presentation.timestamp.at}>{localTimestamp(service.presentation.timestamp.at)}</time>{:else}not observed yet{/if}</p>
              {/if}
            </div>
            <div class="tile-footer">
              <span>{t['board-' + service.state as keyof typeof t]}</span>
              {#if service.checks.length}
                <span class="component-statuses" role="img" aria-label={service.checks.map(check => check.label + ': ' + t['board-' + check.state as keyof typeof t]).join('; ')}>
                  {#each service.checks.slice(0, 8) as check}<span class="component-status" data-state={check.state} title={check.label + ': ' + t['board-' + check.state as keyof typeof t]} aria-hidden="true">{icons[check.state]}</span>{/each}
                  {#if service.checks.length > 8}<span class="component-overflow" title={service.checks.slice(8).map(check => check.label + ': ' + t['board-' + check.state as keyof typeof t]).join('; ')} aria-hidden="true">+{service.checks.length - 8}</span>{/if}
                </span>
              {/if}
            </div>
          </button>
        {/each}
      </div>
      {#if snapshot && !sorted.length}<p class="empty-state">{t['board-no-services']}</p>{/if}
    </main>
    {#if paneOpen}
      {#if !narrow}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (WAI-ARIA focusable window splitter) -->
        <div class="divider" role="separator" aria-label="Resize diagnostics" aria-orientation="vertical" aria-valuemin="20" aria-valuemax="80" aria-valuenow={Math.round((prefs?.splitRatio ?? 0.6) * 100)} tabindex="0" onpointerdown={(e) => { dragging = true; e.preventDefault(); }} onkeydown={resizeKey}></div>{/if}
      <aside class="diagnostic-pane" aria-label="Service diagnostics">
        <div class="pane-heading">
          {#if failures.length}<label class="failure-picker"><span>{failures.length} failed</span><select aria-label="Failed service" value={failures.some(s => s.id === pane.selected) ? pane.selected ?? '' : ''} onchange={(e) => { pane = { owner: 'manual', selected: e.currentTarget.value, tracked: [] }; manual(); }}><option value="" disabled>Select failure</option>{#each failures as service}<option value={service.id}>{service.name}</option>{/each}</select></label>{:else}<span class="muted">{pane.owner === 'auto' ? 'Waiting for confirmed recovery' : t['board-diagnostics']}</span>{/if}
          <button class="close-button" onclick={closePane} aria-label={narrow ? t['board-return'] : 'Close diagnostics'} title="Closing disables Auto diagnostics">{narrow ? '← Grid' : '×'}</button>
        </div>
        {#if selected}<Diagnostics service={selected} restricted={statusOnly} automatic={pane.owner === 'auto'} onmanual={manual} />{:else}<p>{t['board-no-selection']}</p>{/if}
      </aside>
    {/if}
  </div>
</div>

<dialog class="detail-modal" bind:this={dialog} onkeydown={modalKeys} oncancel={(event) => { event.preventDefault(); closeModal(); }}
  onpointerdown={(event) => { backdropDown = event.target === dialog && outsideDialog(event); }}
  onclick={(event) => { if (backdropDown && event.target === dialog && outsideDialog(event)) closeModal(); backdropDown = false; }}
  onclose={() => { if (modalId) closeModal(); }} aria-label={modalService?.name ?? 'Service details'}>
  <button class="modal-close close-button" onclick={closeModal} aria-label="Close details">×</button>
  {#if modalService}<Diagnostics service={modalService} restricted={statusOnly} />{/if}
</dialog>

{#if unlockOpen}
  <aside class="options-sidebar" aria-label="Unlock dashboard">
    <div class="sidebar-heading"><h2>Unlock dashboard</h2><button class="close-button" aria-label="Close unlock" onclick={() => { unlockOpen = false; unlockDraft = ''; }}>×</button></div>
    <form class="option-section" onsubmit={(event) => { event.preventDefault(); void unlockUi(); }}>
      <p>Enable diagnostics and controls in this browser. The code is remembered until you select Lock UI.</p>
      <label for="unlock-code">Unlock code</label>
      <input id="unlock-code" type="password" autocomplete="current-password" maxlength="512" bind:value={unlockDraft} disabled={unlockBusy} required />
      <button type="submit" disabled={unlockBusy}>{unlockBusy ? 'Unlocking…' : 'Unlock dashboard'}</button>
      <p role="status" class="error">{unlockMessage}</p>
    </form>
  </aside>
{/if}

{#if (optionsOpen || layoutOpen) && prefs}
  <aside class="options-sidebar" aria-label={layoutOpen ? 'Custom layout editor' : t['board-runtime-title']}>
    <div class="sidebar-heading"><h2>{layoutOpen ? t['board-layout-edit'] : t['board-runtime-title']}</h2><button class="close-button" aria-label="Close options" onclick={() => { optionsOpen = false; layoutOpen = false; }}>×</button></div>
    {#if layoutOpen}
      <p class="muted">{t['board-layout-help']}</p>
      <label>{t['board-layout-name']}<input maxlength="64" bind:value={layoutName} placeholder={t['board-layout-placeholder']}></label>
      <div class="control-row"><button onclick={() => saveLayout()}>{t['board-layout-add']}</button><button disabled={!prefs.customOrder} onclick={() => saveLayout(true)}>{t['board-layout-rename']}</button><button disabled={!prefs.customOrder} onclick={deleteLayout}>{t['board-layout-delete']}</button></div>
      <p role="status">{layoutMessage}</p>
      {#if prefs.sortMode === 'custom'}<ol class="order-list">{#each sorted as service, index (service.id)}<li><span>{service.name}</span><div><button disabled={index === 0} aria-label={'Move ' + service.name + ' up'} title={'Move ' + service.name + ' up'} onclick={() => step(service.id, -1)}>↑</button><button disabled={index === sorted.length - 1} aria-label={'Move ' + service.name + ' down'} title={'Move ' + service.name + ' down'} onclick={() => step(service.id, 1)}>↓</button></div></li>{/each}</ol>{/if}
    {:else}
      <section class="option-section">
        <h3>Display</h3><p class="muted">Saved display settings apply to every browser.</p>
        <label>{t['board-theme']}
          <select value={prefs.themeOverride ?? ''} onchange={(event) => { if (prefs) { prefs.themeOverride = event.currentTarget.value as Theme || null; persist(); } }}>
            <option value="">{t['board-theme-default']}</option>
            {#each themes as theme}<option value={theme}>{t[`board-theme-${theme}`]}</option>{/each}
          </select>
        </label>
        <label class="check-label"><input type="checkbox" checked={prefs.dense} onchange={(event) => { if (prefs) { prefs.dense = event.currentTarget.checked; persist(); } }}>{t['board-density']}</label>
        <label class="check-label"><input type="checkbox" checked={prefs.keepAwake} onchange={(event) => { if (prefs) { prefs.keepAwake = event.currentTarget.checked; persist(); } }}>{t['board-keep-awake']}</label>
        <p class="muted" role="status">{snapshot?.mode === 'demo' ? t['board-wake-demo'] : t[`board-wake-${wakeState}`]}</p>
        {#if snapshot?.mode === 'live' && prefs.keepAwake && (wakeState === 'denied' || wakeState === 'released')}<button onclick={() => wake?.retry()}>{t['board-wake-retry']}</button>{/if}
        <label class="check-label"><input type="checkbox" bind:checked={pollingPaused} onchange={() => { if (!pollingPaused) void refresh(); }}>{t['board-pause']}</label>
        <button disabled={runtimeBusy} onclick={() => { void runtimeAction({ action: 'refresh' }); }}>{t['board-refresh']}</button>
      </section>
      <section class="option-section">
        <h3>Custom modules</h3><p class="muted">{t['board-reload-help']}</p>
        {#if snapshot?.ui.allowHotReload}
          <label class="check-label"><input type="checkbox" checked={runtime?.watching ?? false} disabled={runtimeBusy || snapshot?.mode === 'demo'} onchange={(e) => { void runtimeAction({ action: 'watchModules', enabled: e.currentTarget.checked }); }}>{t['board-watch']}</label>
          <button disabled={runtimeBusy || snapshot?.mode === 'demo'} onclick={() => { void runtimeAction({ action: 'reloadModules' }); }}>{t['board-reload']}</button>
        {:else}<p>{t['board-options-disabled']}</p>{/if}
        {#if snapshot?.mode === 'demo'}<p class="muted">Modules are not loaded in the offline demo.</p>{/if}
        {#each runtime?.modules ?? [] as module}<p>{module.type} · {module.state}<br><span class="muted">{module.reason ?? ''}</span></p>{/each}
      </section>
      {#if snapshot?.mode === 'demo'}
        <section class="option-section"><h3>Offline scenarios</h3><label>Scenario<select value={runtime?.scenario ?? 'mixed'} disabled={runtimeBusy} onchange={(e) => { void runtimeAction({ action: 'scenario', scenario: e.currentTarget.value }); }}><option value="mixed">Mixed service health</option><option value="failure">New required failure</option><option value="recovery">Confirmed recovery</option><option value="collector-disconnect">Observer disconnected</option><option value="api-disconnect">Board API disconnected</option></select></label><p class="muted">{t['board-simulated']}</p></section>
      {/if}
      <p role="status" class="runtime-message">{runtimeMessage}</p>
      {#if runtime?.version}<p class="build-info">v{runtime.version} · {runtime.buildHash}</p>{/if}
    {/if}
  </aside>
{/if}
