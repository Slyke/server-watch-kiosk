<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { ServiceView, DiagnosticIndex, DiagnosticSection } from '../shared/contracts.js';
  import t from './i18n/en-US.json';
  import { apiFetch } from './api.js';
  let { service, restricted = false, automatic = false, onmanual = () => {} }: { service: ServiceView; restricted?: boolean; automatic?: boolean; onmanual?: () => void } = $props();
  let index = $state<DiagnosticIndex | null>(null);
  let tab = $state('checks'); let pod = $state(''); let container = $state('');
  let previous = $state(false); let paused = $state(false); let follow = $state(true); let lines = $state(200);
  let section = $state<DiagnosticSection | null>(null); let loading = $state(false); let discovering = $state(false); let error = $state('');
  const componentId = $props.id();
  let initializedId = '';
  let controller: AbortController | undefined; let discoveryController: AbortController | undefined; let generation = 0; let manualRevision = 0;
  let logArea = $state<HTMLPreElement>();
  const labels: Record<string, string> = { checks: t['board-checks'], logs: t['board-logs'], description: t['board-description'], events: t['board-events'], probes: t['board-probes'] };
  const manual = () => { manualRevision++; onmanual(); };
  const loadSection = async () => {
    if (tab === 'checks') { controller?.abort(); loading = false; return; }
    controller?.abort(); controller = new AbortController(); const own = controller;
    const requestGeneration = ++generation; const atBottom = !logArea || logArea.scrollHeight - logArea.scrollTop - logArea.clientHeight < 32;
    loading = true; error = '';
    const query = new URLSearchParams({ previous: String(previous), lines: String(lines) });
    if (pod) query.set('pod', pod); if (container) query.set('container', container);
    try {
      const response = await apiFetch(`/api/v1/services/${encodeURIComponent(service.id)}/diagnostics/${tab}?${query}`, { signal: own.signal });
      if (!response.ok) throw new Error('Evidence unavailable or selection changed. Refresh the service to try again.');
      const value = await response.json();
      if (requestGeneration !== generation || own.signal.aborted) return;
      section = value;
      await tick(); if (logArea && follow && atBottom) logArea.scrollTop = logArea.scrollHeight;
    } catch (e) { if (!own.signal.aborted) error = e instanceof Error ? e.message : 'Evidence unavailable'; }
    finally { if (requestGeneration === generation) loading = false; }
  };
  const chooseTab = (value: string) => { manual(); tab = value; section = null; void loadSection(); };
  const choosePod = () => { manual(); container = index?.pods.find(p => p.uid === pod)?.containers[0]?.name ?? ''; previous = false; void loadSection(); };
  const initialize = async (id: string) => {
    controller?.abort(); discoveryController?.abort(); discoveryController = new AbortController(); const own = discoveryController;
    index = null; section = null; tab = 'checks'; pod = ''; container = ''; error = ''; manualRevision = 0; discovering = true;
    const revision = manualRevision;
    try {
      const response = await apiFetch(`/api/v1/services/${encodeURIComponent(id)}/diagnostics`, { signal: own.signal });
      if (!response.ok) throw new Error('Diagnostic choices unavailable');
      index = await response.json();
      pod = index?.pods[0]?.uid ?? ''; container = index?.pods[0]?.containers[0]?.name ?? '';
      if (automatic && !own.signal.aborted) {
        const discovery = await apiFetch(`/api/v1/services/${encodeURIComponent(id)}/diagnostics?discover=true`, { signal: own.signal });
        if (discovery.ok) {
          const found: DiagnosticIndex = await discovery.json();
          if (!own.signal.aborted && revision === manualRevision && found.preferred) {
            tab = found.preferred.kind; pod = found.preferred.pod ?? pod; container = found.preferred.container ?? container; previous = found.preferred.previous ?? false;
            index = found; await loadSection();
          }
        }
      }
    } catch (e) { if (!own.signal.aborted) error = e instanceof Error ? e.message : 'Diagnostics unavailable'; }
    finally { if (!own.signal.aborted) discovering = false; }
  };
  $effect(() => { const id = service.id; const key = `${id}:${restricted}`; if (key !== initializedId) { initializedId = key; untrack(() => { void initialize(id); }); } });
  onMount(() => {
    const timer = setInterval(() => { if (tab === 'logs' && !paused && !loading) void loadSection(); }, 5000);
    return () => { clearInterval(timer); controller?.abort(); discoveryController?.abort(); };
  });
  const tabKeys = (event: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const kinds = index?.kinds ?? ['checks']; const i = kinds.indexOf(tab as never);
    const next = event.key === 'Home' ? 0 : (event.key === 'End' ? kinds.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + kinds.length) % kinds.length);
    chooseTab(kinds[next]!); document.getElementById(componentId + '-tab-' + kinds[next])?.focus();
  };
</script>

<div class="detail-summary">
  <span class="eyebrow">{service.group}</span>
  <h2>{service.name}</h2>
  <p class="summary-state" data-state={service.state}>{t['board-' + service.state as keyof typeof t]} · {service.reason}</p>
  {#if service.lastKnownState}<p class="muted">Previous state: {t['board-' + service.lastKnownState as keyof typeof t]} (historical)</p>{/if}
</div>
{#if index?.notices.length}<p class="muted notice">{index.notices.join(' ')}</p>{/if}
<div class="tabs" role="tablist" tabindex="-1" aria-label="Diagnostic evidence" onkeydown={tabKeys}>
  {#each index?.kinds ?? ['checks'] as kind}
    <button id={componentId + '-tab-' + kind} role="tab" aria-selected={tab === kind} aria-controls={componentId + '-panel'} tabindex={tab === kind ? 0 : -1} onclick={() => chooseTab(kind)}>{labels[kind] ?? kind}</button>
  {/each}
</div>
{#if discovering}<p class="muted" role="status">{t['board-loading']}</p>{/if}
{#if ['logs', 'description', 'events'].includes(tab) && index?.pods.length}
  <div class="diagnostic-controls">
    <label>Pod<select bind:value={pod} onchange={choosePod}>{#each index.pods as p}<option value={p.uid}>{p.source} / {p.namespace} / {p.name}</option>{/each}</select></label>
    {#if tab === 'logs'}
      <label>Container<select bind:value={container} onchange={() => { manual(); previous = false; void loadSection(); }}>{#each index.pods.find(p => p.uid === pod)?.containers ?? [] as c}<option value={c.name}>{c.name}{c.init ? ' (init)' : ''} · {c.restarts} restarts</option>{/each}</select></label>
      <div class="control-row">
        <label class="check-label"><input type="checkbox" bind:checked={previous} onchange={() => { manual(); void loadSection(); }}>{t['board-previous']}</label>
        <label class="check-label"><input type="checkbox" bind:checked={paused} onchange={manual}>{t['board-pause-logs']}</label>
        <label class="check-label"><input type="checkbox" bind:checked={follow} onchange={manual}>{t['board-follow']}</label>
      </div>
    {/if}
  </div>
{/if}
<div id={componentId + '-panel'} class="diag-content" role="tabpanel" aria-labelledby={componentId + '-tab-' + tab} tabindex="0">
  {#if tab === 'checks'}
    <div class="checks-list">
      {#each service.checks as check}
        <article class="check-result" data-state={check.state}>
          <div class="check-title"><strong>{check.label}</strong><span class="state-label">{t['board-' + check.state as keyof typeof t]}</span></div>
          <p>{check.reason}</p>
          <div class="facts"><span>{check.required ? 'Required' : 'Optional'}</span><span>{check.ageMs === null ? 'No trusted observation' : 'Observed ' + Math.round(check.ageMs / 1000) + 's ago'}</span></div>
          {#if check.confirmation}<p class="confirmation">Confirming {check.confirmation.phase} · {Math.ceil(check.confirmation.remainingMs / 1000)}s remaining</p>{/if}
          {#if check.eventAt}<p class="muted">Event: {check.eventAt}</p>{/if}
          {#if check.measurements}<div class="facts">{#each Object.entries(check.measurements) as [key, value]}<span>{key}: {String(value)}</span>{/each}</div>{/if}
        </article>
      {/each}
      {#each service.dependencies as dependency}
        <article class="check-result" data-state={dependency.state}><strong>Dependency · {dependency.name}</strong><p>{dependency.reason}</p><span class="muted">{dependency.required ? 'Required' : 'Optional'} · {dependency.state}</span></article>
      {/each}
    </div>
  {:else}
    {#if loading && !section}<p role="status">{t['board-loading']}</p>{/if}
    {#if error}<p class="error" role="status">{error}</p>{/if}
    {#if section}
      <div class="evidence-meta"><span>{section.availability}{section.previous ? ' · previous container' : ''}</span><span>{loading ? 'Updating…' : section.observedAt}</span></div>
      <pre bind:this={logArea} class="log-text" onscroll={() => { if (logArea && logArea.scrollHeight - logArea.scrollTop - logArea.clientHeight > 32) follow = false; }}>{section.text || t['board-no-logs']}</pre>
      {#if section.truncated}<p class="muted">Output truncated at the response limit.</p>{/if}
      {#if tab === 'logs'}<button disabled={lines >= 2000} onclick={() => { manual(); lines = Math.min(2000, lines * 2); void loadSection(); }}>{t['board-load-more']} ({lines} / 2000 lines)</button>{/if}
    {/if}
  {/if}
</div>
{#if service.links.length}<div class="control-row">{#each service.links as link}<a href={link.url} target="_blank" rel="noreferrer">{link.label} ↗</a>{/each}</div>{/if}
