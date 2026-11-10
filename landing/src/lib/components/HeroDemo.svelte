<script lang="ts">
  // A scripted illustration of the supported Tempo image journey.
  // Nothing here contacts a service, invokes Touch ID or makes a payment.
  import { onMount } from 'svelte';

  const hosts = [
    { id: 'claude', name: 'Claude Code', agent: 'Claude', path: 'claude ~/hackathon' },
    { id: 'codex', name: 'Codex', agent: 'Codex', path: 'codex ~/hackathon' }
  ];
  const prompt = 'Generate one sailboat image using Tempo, within my approved budget.';

  // Illustrative quote only; real purchases always use the backend's exact quote.
  const plan = [
    { label: 'One image', id: 'image.generate', amount: '0.010000' }
  ];

  // Phases: 1 asked · 2 readiness · 3 check · 4 ready · 5 permission review
  // 6 permission approved · 7 exact quote · 8 Touch ID signing · 9 generation · 10 result
  const RUN = 9;
  const delays = [600, 700, 1200, 600, 1900, 900, 1700, 1400, 1500, 6500];
  const last = delays.length;

  let host = $state(0);
  let typed = $state(0);
  let phase = $state(0);
  let timer: ReturnType<typeof setTimeout>;
  let reduced = false;
  let body: HTMLDivElement;

  const agent = $derived(hosts[host].agent);

  function clear() {
    clearTimeout(timer);
  }

  function type() {
    if (typed < prompt.length) {
      typed += 1;
      timer = setTimeout(type, 26);
    } else {
      timer = setTimeout(advance, 250);
    }
  }

  function advance() {
    phase += 1;
    if (phase < last) timer = setTimeout(advance, delays[phase - 1]);
    else timer = setTimeout(restart, delays[last - 1]);
  }

  function restart() {
    clear();
    phase = 0;
    typed = 0;
    if (reduced) {
      typed = prompt.length;
      phase = last;
      return;
    }
    timer = setTimeout(type, 500);
  }

  function pick(i: number) {
    if (i === host) return;
    host = i;
    restart();
  }

  // Start at the top; once the feed outgrows the window, follow the newest line.
  $effect(() => {
    void phase;
    void host;
    requestAnimationFrame(() => body?.scrollTo({ top: body.scrollHeight, behavior: reduced || phase === 0 ? 'auto' : 'smooth' }));
  });

  onMount(() => {
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    restart();
    return clear;
  });
</script>

{#snippet state(done: boolean)}
  <span class="state" class:ok={done}>{#if done}✓{:else}<span class="spin"></span>{/if}</span>
{/snippet}

<div class="card demo rise" aria-label="Mocked demo of Algoria inside {hosts[host].name}" role="figure">
  <div class="head">
    <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="path">{hosts[host].path}</span>
    <div class="segmented" role="group" aria-label="Show the demo in">
      {#each hosts as h, i (h.id)}
        <button type="button" aria-pressed={host === i} onclick={() => pick(i)}>{h.name}</button>
      {/each}
    </div>
  </div>

  <div class="body" aria-live="off" bind:this={body}>
    <div class="feed">
      <div class="msg user">
        <span class="caret" aria-hidden="true">›</span>
        <p>{prompt.slice(0, typed)}{#if phase === 0}<span class="cursor" aria-hidden="true"></span>{/if}</p>
      </div>

      {#if phase >= 2}
        <p class="msg enter"><b>{agent}</b> I'll use Algoria's Tempo image service. First, a local wallet check.</p>
      {/if}

      {#if phase >= 3}
        <div class="tool enter">
          {@render state(phase >= 4)}
          <code>algoria pay readiness</code>
          {#if phase >= 4}<span class="out enter">Companion + Touch ID ready</span>{/if}
        </div>
      {/if}

      {#if phase >= 5}
        <p class="msg enter"><b>{agent}</b> Review your local spending permission. This does not pay for anything.</p>
        <div class="panel enter">
          <div class="p-top">
            <span class="p-name">Local spending permission</span>
            <span class="p-note">No payment now</span>
          </div>
          <dl>
            <div><dt>Total / per purchase</dt><dd class="mono">0.01 test PathUSD</dd></div>
            <div><dt>Scope</dt><dd>Algoria images · Tempo testnet</dd></div>
            <div><dt>Expiry</dt><dd>In one hour</dd></div>
          </dl>
          <div class="p-status" class:ok={phase >= 6}>
            {@render state(phase >= 6)}
            {phase >= 6 ? 'Permission approved with Touch ID' : 'Review locally, then approve with Touch ID…'}
          </div>
        </div>
      {/if}

      {#if phase >= 7}
        <p class="msg enter"><b>{agent}</b> Here is the MPP quote. Review the exact payment in your local wallet.</p>
        <div class="panel enter">
          <ul class="plan">
            {#each plan as step, i (step.id)}
              <li>
                {#if phase >= RUN + i}
                  {@render state(phase >= RUN + i + 1)}
                {:else}
                  <span class="state idle"></span>
                {/if}
                <span class="s-label">{step.label}</span>
                <code>{step.id}</code>
                <span class="s-price">{step.amount}</span>
              </li>
            {/each}
          </ul>
          <div class="p-foot">
            <span>Example <b>0.01 test PathUSD</b></span>
            <span class="approve" class:done={phase >= 9}>{phase >= 9 ? '✓ Signed' : 'Touch ID'}</span>
          </div>
        </div>
      {/if}

      {#if phase >= 9}
        <p class="msg enter"><b>{agent}</b> MPP receipt verified. Generating your image—same saved task if interrupted.</p>
      {/if}

      {#if phase >= 10}
        <div class="result enter">
          <div class="image-placeholder" aria-hidden="true">
            <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M32 10v33H13L32 10Z M37 19l13 24H37V19Z M10 48h44l-7 7H18l-8-7Z M9 59c5-3 9 3 14 0s9 3 14 0 9 3 14 0" /></svg>
          </div>
          <div class="r-copy">
            <p><b>{agent}</b> Done. Your image is ready.</p>
            <span class="meta"><code>sailboat.png</code></span>
            <span class="meta">Tempo testnet · MPP receipt<br />0.010000 test PathUSD · illustration only</span>
          </div>
        </div>
      {/if}
    </div>
  </div>

  <div class="foot">
    <span class="live-dot" aria-hidden="true"></span>
    <span>Mocked demo · Tempo testnet · no payment here</span>
    <button type="button" class="replay" onclick={restart} aria-label="Replay demo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
      Replay
    </button>
  </div>
</div>

<style>
  .demo {
    min-width: 0;
    overflow: hidden;
    animation-delay: 0.08s;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px 12px 16px;
    border-bottom: 1px solid var(--border);
  }

  .dots {
    display: inline-flex;
    gap: 6px;
  }

  .dots i {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--border-strong);
  }

  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: 11.5px var(--mono);
    color: var(--txt-muted);
  }

  .segmented {
    display: flex;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--well);
  }

  .segmented button {
    padding: 4px 10px;
    border: 0;
    border-radius: 7px;
    background: none;
    font-size: 12px;
    font-weight: 500;
    color: var(--txt-muted);
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }

  .segmented button:hover {
    color: var(--txt-sec);
  }

  .segmented button[aria-pressed='true'] {
    background: var(--elevated);
    color: var(--txt);
    box-shadow: inset 0 1px 0 var(--spec), 0 1px 2px #0003;
  }

  .body {
    height: 440px;
    overflow: hidden;
    padding: 18px;
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 16px);
    mask-image: linear-gradient(to bottom, transparent 0, #000 16px);
  }

  .feed {
    display: grid;
    gap: 12px;
  }

  .msg {
    font-size: 13.5px;
    line-height: 1.6;
    color: var(--txt-sec);
  }

  .msg b,
  .r-copy b {
    display: block;
    margin-bottom: 2px;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--txt-muted);
  }

  .user {
    display: flex;
    gap: 10px;
    min-height: 46px;
    padding: 11px 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--well);
    color: var(--txt);
  }

  .caret {
    font: 500 14px var(--mono);
    color: var(--txt-muted);
  }

  .cursor {
    display: inline-block;
    width: 7px;
    height: 15px;
    margin-left: 2px;
    vertical-align: -2px;
    background: var(--txt-sec);
    animation: blink 1s steps(1) infinite;
  }

  code,
  .mono {
    font: 12px var(--mono);
  }

  .tool {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 10px;
    font: 12px var(--mono);
    color: var(--txt-sec);
  }

  .state {
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    flex-shrink: 0;
    border: 1px solid var(--border-strong);
    border-radius: 50%;
    font-size: 10px;
    color: var(--txt-muted);
  }

  .state.ok {
    border-color: color-mix(in srgb, var(--online) 45%, transparent);
    color: var(--online);
  }

  .state.idle {
    border-style: dashed;
  }

  .spin {
    width: 10px;
    height: 10px;
    border: 1.5px solid var(--border-strong);
    border-top-color: var(--txt-sec);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .out {
    margin-left: auto;
    color: var(--txt-muted);
  }

  .panel {
    display: grid;
    gap: 12px;
    padding: 14px;
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    background: var(--raised);
  }

  .p-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  .p-name {
    font-size: 13.5px;
    font-weight: 500;
  }

  .p-note {
    font: 12px var(--mono);
    color: var(--txt-muted);
  }

  dl {
    display: grid;
    gap: 5px;
    margin: 0;
    font-size: 12px;
  }

  dl div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }

  dt {
    color: var(--txt-muted);
  }

  dd {
    margin: 0;
    color: var(--txt);
    text-align: right;
  }

  .p-status {
    display: flex;
    align-items: center;
    gap: 9px;
    padding-top: 11px;
    border-top: 1px solid var(--border);
    font-size: 12.5px;
    color: var(--txt-muted);
  }

  .p-status.ok {
    color: var(--online);
  }

  .plan {
    list-style: none;
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
  }

  .plan li {
    display: grid;
    grid-template-columns: 18px 84px minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    font-size: 12.5px;
    color: var(--txt-sec);
  }

  .plan code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11.5px;
    color: var(--txt-muted);
  }

  .s-price {
    font: 12px var(--mono);
    color: var(--txt-sec);
  }

  .p-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-top: 11px;
    border-top: 1px solid var(--border);
    font-size: 12.5px;
    color: var(--txt-muted);
  }

  .p-foot b {
    font-weight: 500;
    color: var(--txt);
  }

  .approve {
    flex-shrink: 0;
    white-space: nowrap;
    padding: 5px 14px;
    border-radius: 8px;
    background: var(--txt);
    color: var(--bg);
    font-size: 12px;
    font-weight: 500;
    transition: background 0.2s, color 0.2s;
  }

  .approve.done {
    background: color-mix(in srgb, var(--online) 18%, transparent);
    color: var(--online);
  }

  .result {
    display: flex;
    align-items: center;
    gap: 18px;
  }

  /* Repo-native illustration, not a generated service result. */
  .image-placeholder {
    display: grid;
    place-items: center;
    width: 100px;
    aspect-ratio: 1;
    flex-shrink: 0;
    overflow: hidden;
    border: 1px solid var(--border-strong);
    border-radius: 14px;
    color: var(--accent);
    background: var(--raised);
  }

  .image-placeholder svg {
    width: 64px;
    height: 64px;
  }

  .r-copy {
    display: grid;
    gap: 6px;
    font-size: 13.5px;
    line-height: 1.6;
    color: var(--txt-sec);
  }

  .r-copy code {
    color: var(--txt);
  }

  .meta {
    font: 11px/1.6 var(--mono);
    color: var(--txt-muted);
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 9px 12px 9px 16px;
    border-top: 1px solid var(--border);
    font: 11px var(--mono);
    color: var(--txt-muted);
  }

  .foot span:not(.live-dot) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .replay {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    padding: 4px 9px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: none;
    font: inherit;
    color: var(--txt-muted);
    cursor: pointer;
    transition: color 0.15s, background 0.15s, border-color 0.15s;
  }

  .replay:hover {
    color: var(--txt);
    background: var(--active-bg);
    border-color: var(--border-strong);
  }

  .replay svg {
    width: 12px;
    height: 12px;
  }

  .enter {
    animation: enter 0.35s ease backwards;
  }

  @keyframes enter {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes blink {
    50% {
      opacity: 0;
    }
  }

  @media (max-width: 560px) {
    .path {
      display: none;
    }

    .segmented {
      margin-left: auto;
    }

    .body {
      height: 460px;
      padding: 14px;
    }

    .out {
      margin-left: 28px;
      flex-basis: 100%;
    }

    .plan li {
      grid-template-columns: 18px minmax(0, 1fr) auto;
    }

    .plan code {
      display: none;
    }

    .result {
      gap: 14px;
    }

    dl div {
      flex-direction: column;
      gap: 1px;
    }

    dd {
      text-align: left;
    }

  }
</style>
