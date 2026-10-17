<script lang="ts">
  import type { CheckView } from '../shared/contracts.js';
  let { checks, icons, labels }: { checks: CheckView[]; icons: Record<string, string>; labels: Record<string, string> } = $props();
  let width = $state(0);
  let counterWidth = $state(24);
  const limit = $derived(checks.length > 8 ? 7 : checks.length);
  const visible = $derived(width > 0 && checks.length * 21 - 3 > width
    ? Math.max(0, Math.min(limit, Math.floor((width - Math.ceil(counterWidth)) / 21))) : limit);
  const description = (check: CheckView) => check.label + ': ' + labels['board-' + check.state];
</script>

<span class="component-statuses" bind:clientWidth={width} style:width={Math.min(checks.length, 8) * 21 - 3 + 'px'}
  role="img" aria-label={checks.map(description).join('; ')}>
  <span class="component-counter-measure" bind:clientWidth={counterWidth} aria-hidden="true">+{checks.length}</span>
  {#each checks.slice(0, visible) as check}<span class="component-status" data-state={check.state} title={description(check)} aria-hidden="true">{icons[check.state]}</span>{/each}
  {#if checks.length > visible}<span class="component-overflow" title={checks.slice(visible).map(description).join('; ')} aria-hidden="true">+{checks.length - visible}</span>{/if}
</span>
