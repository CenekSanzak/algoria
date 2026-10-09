<script lang="ts">
  import { site } from '$lib/links';
  import HeroDemo from '$lib/components/HeroDemo.svelte';

  const facts = [
    'MPP payments on Tempo testnet',
    'Local spending limits, expiry & revocation',
    'Review and sign with Touch ID'
  ];

  const steps = [
    { title: 'Install', body: 'Add the plugin to Claude Code or Codex and build the lightweight local wallet on your Touch ID Mac.' },
    { title: 'Set your limits', body: 'Choose a budget, a per-purchase limit and an expiry. Review and approve your local spending permission with Touch ID.' },
    {
      title: 'Ask and approve',
      body: 'Ask for an image. Your assistant gets a quote, you review the exact payment in the local wallet, and Touch ID signs it on Tempo testnet.'
    }
  ];
</script>

<svelte:head>
  <title>Algoria</title>
  <meta name="description" content={site.description} />
  <link rel="canonical" href={site.url} />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Algoria" />
  <meta property="og:url" content={site.url} />
  <meta property="og:title" content={site.title} />
  <meta property="og:description" content={site.description} />
  <meta property="og:image" content="{site.url}algoria-tempo-preview.jpg" />
  <meta property="og:image:alt" content="Algoria plugin for Claude and Codex: Tempo testnet MPP payments with a local wallet and Touch ID." />
  <meta property="og:image:width" content="1280" />
  <meta property="og:image:height" content="720" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="{site.url}algoria-tempo-preview.jpg" />
</svelte:head>

<section class="wrap hero" aria-labelledby="hero-title">
  <div class="copy rise">
    <p class="eyebrow"><span class="live-dot" aria-hidden="true"></span>Plugin for Claude &amp; Codex</p>
    <h1 id="hero-title">Go beyond<br /><span class="nowrap">Claude &amp; Codex.</span><br /><span class="silver nowrap">Without leaving&nbsp;them.</span></h1>
    <p class="pay-line">
      Pay for AI with
      <span class="tempo-chip">Tempo</span>
    </p>
    <p class="lead">
      One plugin, and your assistant can buy AI-generated images with MPP on Tempo. No provider API keys to manage.
      Review the price in a lightweight local wallet and approve with Touch ID—without leaving your workflow.
    </p>
    <p class="release-note">Testnet demo · test PathUSD · macOS + Touch ID · local wallet build required</p>
    <ul class="facts" aria-label="Key facts">
      {#each facts as fact (fact)}
        <li>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
          {fact}
        </li>
      {/each}
    </ul>

    <div class="actions">
      <a class="btn primary" href="/how-to-use">Get started</a>
      <a class="btn" href="/how-to-use#use">Example prompts</a>
    </div>
  </div>

  <HeroDemo />
</section>

<section class="wrap how" id="how" aria-labelledby="how-title">
  <div class="how-head">
    <p class="eyebrow">How it works</p>
    <h2 id="how-title">Install. Set limits. Ask.</h2>
  </div>
  <ol class="card steps">
    {#each steps as step, i (step.title)}
      <li>
        <span class="num">{String(i + 1).padStart(2, '0')}</span>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
      </li>
    {/each}
  </ol>
</section>

<style>
  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.02fr);
    gap: 64px;
    align-items: center;
    padding-block: 56px 104px;
  }

  h1 {
    margin-top: 20px;
    font-size: clamp(36px, 4.1vw, 46px);
    line-height: 1.08;
    font-weight: 600;
    letter-spacing: -0.02em;
    text-wrap: balance;
  }

  .nowrap {
    white-space: nowrap;
  }
  .silver {
    background: var(--silver);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  .pay-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 22px;
    font-size: 18px;
    font-weight: 500;
    color: var(--txt-sec);
  }

  .tempo-chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 3px 12px 3px 10px;
    border: 1px solid var(--tempo-border);
    border-radius: 10px;
    background: var(--tempo-bg);
    color: var(--tempo);
  }

  .lead {
    margin-top: 18px;
    max-width: 440px;
    font-size: 15px;
    line-height: 1.65;
    color: var(--txt-muted);
  }

  .facts {
    list-style: none;
    display: grid;
    gap: 10px;
    margin-top: 28px;
    padding: 0;
    font: 12px var(--mono);
    color: var(--txt-sec);
  }

  .release-note {
    margin-top: 14px;
    font: 11px/1.7 var(--mono);
    color: var(--txt-muted);
  }

  .facts li {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .facts svg {
    width: 12px;
    height: 12px;
    opacity: 0.7;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 32px;
  }

  .btn {
    padding: 10px 18px;
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    background: var(--active-bg);
    font-size: 14px;
    font-weight: 500;
    color: var(--txt);
    transition: background 0.15s, border-color 0.15s, opacity 0.15s;
  }

  .btn:hover {
    border-color: var(--accent);
  }

  .btn.primary {
    border-color: transparent;
    background: var(--txt);
    color: var(--bg);
  }

  .btn.primary:hover {
    opacity: 0.88;
  }

  .how {
    padding-bottom: 128px;
  }

  .how-head {
    display: grid;
    gap: 10px;
    margin-bottom: 28px;
  }

  h2 {
    font-size: clamp(26px, 2.6vw, 32px);
    font-weight: 600;
    letter-spacing: -0.015em;
  }

  .steps {
    list-style: none;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    padding: 0;
  }

  .steps li {
    padding: 28px 28px 30px;
  }

  .steps li + li {
    border-left: 1px solid var(--border);
  }

  .num {
    font: 500 11px var(--mono);
    letter-spacing: 0.06em;
    color: var(--txt-muted);
  }

  h3 {
    margin-top: 18px;
    font-size: 16px;
    font-weight: 500;
  }

  .steps p {
    margin-top: 8px;
    font-size: 14px;
    line-height: 1.65;
    color: var(--txt-muted);
  }

  @media (max-width: 900px) {
    .hero {
      grid-template-columns: 1fr;
      gap: 48px;
      padding-block: 36px 80px;
    }

    .lead {
      max-width: 560px;
    }

    .steps {
      grid-template-columns: 1fr;
    }

    .steps li {
      padding: 22px 22px 24px;
    }

    .steps li + li {
      border-left: 0;
      border-top: 1px solid var(--border);
    }

    h3 {
      margin-top: 10px;
    }

    .how {
      padding-bottom: 88px;
    }
  }

  @media (max-width: 560px) {
    .silver.nowrap {
      white-space: normal;
    }
    .hero {
      padding-block: 24px 64px;
    }

    .pay-line {
      font-size: 16px;
    }
  }
</style>
