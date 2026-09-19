<script lang="ts">
  // A scripted, mocked session: nothing here calls the network. It follows the
  // real skill flow (wallet onboard → TRY top-up → quote → pay per service) with
  // the five Algoria services that make a narrated, captioned video.
  import { onMount } from 'svelte';

  const hosts = [
    { id: 'claude', name: 'Claude Code', agent: 'Claude', path: 'claude ~/hackathon' },
    { id: 'codex', name: 'Codex', agent: 'Codex', path: 'codex ~/hackathon' }
  ];
  const prompt = 'Create a TikTok video with voiceover for my hackathon project.';

  // Prices are the live testnet prices of each service, in USDC.
  const plan = [
    { label: 'Images ×3', id: 'image.generate', usdc: '0.03' },
    { label: 'Voiceover', id: 'speech.generate', usdc: '0.02' },
    { label: 'Slideshow', id: 'video.slideshow', usdc: '0.01' },
    { label: 'Narration', id: 'video.compose', usdc: '0.01' },
    { label: 'Captions', id: 'video.caption', usdc: '0.02' }
  ];

  // Phases: 1 asked · 2 plan · 3 onboarding · 4 wallet ready · 5 top-up opened
  // 6 lira received · 7 quote · 8 approved · 9–13 services run · 14 all paid · 15 video
  const RUN = 9;
  const delays = [600, 700, 1200, 600, 1900, 900, 1700, 500, 800, 800, 800, 800, 800, 500, 6500];
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
        <p class="msg enter"><b>{agent}</b> I can't make videos myself, but Algoria can. First, a wallet.</p>
      {/if}

      {#if phase >= 3}
        <div class="tool enter">
          {@render state(phase >= 4)}
          <code>algoria wallet onboard</code>
          {#if phase >= 4}<span class="out enter">GBX4…Q7LM · key stays here</span>{/if}
        </div>
      {/if}

      {#if phase >= 5}
        <p class="msg enter"><b>{agent}</b> Your wallet is empty. Send 200 TRY by bank transfer:</p>
        <div class="panel enter">
          <div class="p-top">
            <span class="p-name">Top up · 200 TRY</span>
            <span class="p-note">≈ 4.76 USDC</span>
          </div>
          <dl>
            <div><dt>IBAN</dt><dd class="mono">TR33 0006 1005 1978 6457 8413 26</dd></div>
            <div><dt>Reference</dt><dd class="mono">TRMA-7K2Q</dd></div>
          </dl>
          <div class="p-status" class:ok={phase >= 6}>
            {@render state(phase >= 6)}
            {phase >= 6 ? 'Received · 4.76 USDC in your wallet' : 'Waiting for your transfer…'}
          </div>
        </div>
      {/if}

      {#if phase >= 7}
        <p class="msg enter"><b>{agent}</b> 5 Algoria services make a 30-second video with voice and captions.</p>
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
                <span class="s-price">{step.usdc}</span>
              </li>
            {/each}
          </ul>
          <div class="p-foot">
            <span>Total <b>0.09 USDC</b> · ≈ ₺3.78</span>
            <span class="approve" class:done={phase >= 8}>{phase >= 8 ? '✓ Approved' : 'Approve'}</span>
          </div>
        </div>
      {/if}

      {#if phase >= 15}
        <div class="result enter">
          <div class="video" aria-hidden="true">
            <div class="v-bg"></div>
            <div class="v-top">
              <span class="v-brand">algoria</span>
              <span class="v-title">Buy AI services<br />inside {agent}</span>
            </div>
            <span class="v-play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor" /></svg></span>
            <span class="v-cap">Pay in <mark>lira</mark> on Stellar</span>
            <span class="v-bar"><i></i></span>
          </div>
          <div class="r-copy">
            <p><b>{agent}</b> Done. Your video is ready to post.</p>
            <span class="meta"><code>hackathon-tiktok.mp4</code></span>
            <span class="meta">0:28 · voice + captions<br />paid 0.09 USDC ≈ ₺3.78</span>
          </div>
        </div>
      {/if}
    </div>
  </div>

  <div class="foot">
    <span class="live-dot" aria-hidden="true"></span>
    <span>Mocked demo · the real flow runs on Stellar testnet</span>
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

  /* Placeholder for the finished vertical video: a looping still with captions. */
  .video {
    position: relative;
    width: 124px;
    aspect-ratio: 9 / 16;
    flex-shrink: 0;
    overflow: hidden;
    border: 1px solid var(--border-strong);
    border-radius: 14px;
    color: #fff;
    background: #0d1020;
  }

  .v-bg {
    position: absolute;
    inset: -40%;
    background:
      radial-gradient(circle at 30% 30%, #7c5cff 0, transparent 45%),
      radial-gradient(circle at 70% 60%, #ff5c8a 0, transparent 42%),
      radial-gradient(circle at 40% 85%, #2fd3c5 0, transparent 40%);
    filter: blur(8px);
    opacity: 0.85;
    animation: drift 7s ease-in-out infinite alternate;
  }

  .v-top {
    position: absolute;
    inset: 16px 12px auto;
    display: grid;
    gap: 6px;
  }

  .v-brand {
    font: 600 9px var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    opacity: 0.8;
  }

  .v-title {
    font-size: 15px;
    font-weight: 600;
    line-height: 1.15;
    text-shadow: 0 1px 8px #0006;
  }

  .v-play {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: #ffffff33;
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
    transform: translate(-50%, -30%);
  }

  .v-play svg {
    width: 16px;
    height: 16px;
    margin-left: 2px;
  }

  .v-cap {
    position: absolute;
    inset: auto 10px 20px;
    padding: 4px 6px;
    border-radius: 6px;
    background: #000000a6;
    font-size: 10px;
    font-weight: 500;
    text-align: center;
  }

  .v-cap mark {
    background: none;
    color: #ffd166;
  }

  .v-bar {
    position: absolute;
    inset: auto 10px 9px;
    height: 3px;
    border-radius: 2px;
    background: #ffffff33;
    overflow: hidden;
  }

  .v-bar i {
    display: block;
    height: 100%;
    background: #fff;
    animation: play 6s linear infinite;
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

  @keyframes drift {
    to {
      transform: translate(12%, -8%) rotate(20deg);
    }
  }

  @keyframes play {
    from {
      width: 0;
    }
    to {
      width: 100%;
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

    .video {
      width: 104px;
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
