<script lang="ts">
  import { site } from '$lib/links';
  import InstallCard from '$lib/components/InstallCard.svelte';
  import CodeBlock from '$lib/components/CodeBlock.svelte';

  // What to type in Claude Code or Codex; the plugin runs the commands itself.
  const steps = [
    { title: 'Create your wallet', body: 'Made on your machine. The key never leaves it.', ask: 'Set up my Algoria wallet.' },
    { title: 'Top up in lira', body: 'You get an IBAN and a reference. It arrives as USDC.', ask: 'Top up 200 TRY.' },
    { title: 'Set a budget', body: 'Your assistant only spends what you approve.', ask: 'Let Algoria spend up to 0.10 USDC.' },
    { title: 'Ask for anything', body: 'It finds the services, shows the price and pays.', ask: 'Create a TikTok video with voiceover for my hackathon project.' }
  ];
</script>

<svelte:head>
  <title>How to use — Algoria</title>
  <meta name="description" content="Install Algoria in Claude Code or Codex, top up in Turkish lira and ask your assistant for AI services." />
  <link rel="canonical" href="{site.url}how-to-use" />
</svelte:head>

<section class="wrap intro" aria-labelledby="page-title">
  <div class="copy rise">
    <p class="eyebrow">How to use</p>
    <h1 id="page-title">Set up once.<br /><span class="silver">Then just ask.</span></h1>
    <p class="lead">
      Install the plugin in Claude Code or Codex. Then ask your assistant, and it handles the wallet, the top-up and
      the payments for you.
    </p>
    <ul class="needs" aria-label="Requirements">
      <li>Claude Code or Codex</li>
      <li>Node.js 22+</li>
      <li>Stellar testnet · not real money</li>
    </ul>
  </div>
  <InstallCard />
</section>

<section class="wrap use" id="use" aria-labelledby="use-title">
  <div class="use-head">
    <p class="eyebrow">Step by step</p>
    <h2 id="use-title">Just ask your assistant.</h2>
  </div>

  <ol class="card steps">
    {#each steps as step, i (step.title)}
      <li>
        <span class="num">{String(i + 1).padStart(2, '0')}</span>
        <div class="info">
          <h3>{step.title}</h3>
          <p>{step.body}</p>
        </div>
        <CodeBlock code={step.ask} label="Copy prompt" variant="ask" />
      </li>
    {/each}
  </ol>
</section>

<style>
  .intro {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.02fr);
    gap: 64px;
    align-items: center;
    padding-block: 96px 104px;
  }

  h1 {
    margin-top: 20px;
    font-size: clamp(36px, 4.1vw, 46px);
    line-height: 1.08;
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .silver {
    background: var(--silver);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  .lead {
    margin-top: 20px;
    max-width: 440px;
    font-size: 15px;
    line-height: 1.65;
    color: var(--txt-muted);
  }

  .needs {
    list-style: none;
    display: grid;
    gap: 10px;
    margin-top: 28px;
    padding: 0;
    font: 12px var(--mono);
    color: var(--txt-sec);
  }

  .needs li::before {
    content: '·';
    margin-right: 10px;
    color: var(--txt-muted);
  }

  .use {
    padding-bottom: 128px;
  }

  .use-head {
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
    padding: 0;
  }

  .steps li {
    display: grid;
    grid-template-columns: 32px minmax(0, 0.9fr) minmax(0, 1.1fr);
    align-items: center;
    gap: 24px;
    padding: 20px 24px;
  }

  .steps li + li {
    border-top: 1px solid var(--border);
  }

  .num {
    font: 500 11px var(--mono);
    letter-spacing: 0.06em;
    color: var(--txt-muted);
  }

  h3 {
    font-size: 16px;
    font-weight: 500;
  }

  .info p {
    margin-top: 4px;
    font-size: 14px;
    line-height: 1.65;
    color: var(--txt-muted);
  }

  @media (max-width: 900px) {
    .intro {
      grid-template-columns: 1fr;
      gap: 48px;
      padding-block: 64px 80px;
    }

    .steps li {
      grid-template-columns: 32px minmax(0, 1fr);
      gap: 12px 16px;
      padding: 20px;
    }

    .num {
      align-self: start;
      margin-top: 5px;
    }

    .steps li > :global(.code) {
      grid-column: 1 / -1;
    }

    .use {
      padding-bottom: 88px;
    }
  }

  @media (max-width: 560px) {
    .intro {
      padding-block: 44px 64px;
    }

    .steps li {
      padding: 18px 16px;
    }
  }
</style>
