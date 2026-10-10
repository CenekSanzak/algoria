<script lang="ts">
  import { links, site } from '$lib/links';
  import InstallCard from '$lib/components/InstallCard.svelte';
  import CodeBlock from '$lib/components/CodeBlock.svelte';

  // What to type in Claude Code or Codex; the plugin runs the commands itself.
  const steps = [
    { title: 'Check readiness', body: 'After building the companion above, check that the local wallet and Touch ID are available. No payment yet.', ask: 'Check if my local Tempo wallet is ready. Do not sign or pay yet.' },
    { title: 'Set a budget', body: 'Review the service recipient, total limit, per-purchase limit and expiry in the local wallet. Touch ID approves the permission, not a payment.', ask: 'Set a Tempo image budget of 0.01 test PathUSD total and per purchase, expiring in one hour, for this assistant and the current Algoria image-service recipient.' },
    { title: 'Ask for an image', body: 'Your assistant gets an MPP quote. Review the prompt, recipient, exact price and fee bounds before Touch ID signs. Test tokens have no real value; generation uses a real provider.', ask: 'Generate one image of a sailboat at sunset using Tempo MPP, within that budget. Use testnet faucet tokens and show the exact payment for my Touch ID approval.' },
    { title: 'Recover or revoke', body: 'Resume the same saved task after an interruption. Revoke the local budget to stop future dispatches; this does not undo a submitted payment.', ask: 'Show my saved Tempo image task without making another payment, then revoke its local spending permission.' }
  ];
</script>

<svelte:head>
  <title>How to use — Algoria</title>
  <meta name="description" content="Install Algoria in Claude Code or Codex, build the local macOS wallet and approve Tempo testnet MPP image payments with Touch ID." />
  <link rel="canonical" href="{site.url}how-to-use/" />
</svelte:head>

<section class="wrap intro" aria-labelledby="page-title">
  <div class="copy rise">
    <p class="eyebrow">How to use</p>
    <h1 id="page-title">Set up once.<br /><span class="silver">Then just ask.</span></h1>
    <p class="lead">
      Install the plugin in Claude Code or Codex and build the local wallet companion. Ask for an image,
      review the quote and approve with Touch ID. No bank transfer or external approval link.
    </p>
    <nav class="setup-nav" aria-label="Setup steps">
      <a href="#install">1. Install plugin</a>
      <a href="#wallet">2. Build wallet</a>
      <a href="#use">3. Try a prompt</a>
    </nav>
    <ul class="needs" aria-label="Requirements">
      <li>Claude Code or Codex</li>
      <li>Node.js 22+</li>
      <li>macOS 15+ with enrolled Touch ID</li>
      <li>Xcode command-line tools for the local build</li>
      <li>Tempo Moderato testnet · test PathUSD</li>
    </ul>
  </div>
  <InstallCard />
</section>

<section class="wrap setup" id="wallet" aria-labelledby="setup-title">
  <div class="card setup-card">
    <p class="eyebrow">Developer preview</p>
    <h2 id="setup-title">Build the local wallet first.</h2>
    <p>The plugin is available on npm. The native wallet is a separate development build, not a packaged or notarized installer.</p>
    <CodeBlock code={'git clone https://github.com/CenekSanzak/algoria.git\ncd algoria/native/tempo-signing-proof\nnpm ci --ignore-scripts\nnpm run build\nexport ALGORIA_TEMPO_SIGNER_APP="$PWD/.build/Algoria Signing Proof.app"'} label="Copy companion build commands" />
    <p>Start Claude Code or Codex from that same terminal so it inherits the wallet path. For desktop sessions, configure that environment variable in the host that launches the plugin.</p>
    <p>The signing account is disposable. Never send real funds to it. Budgets are local permissions, not autonomous signing or full ERC-8196 compliance. Every new payment still needs Touch ID.</p>
    <a href="{links.github}/blob/main/native/tempo-signing-proof/README.md" target="_blank" rel="noopener noreferrer">Read wallet setup and limitations ↗</a>
  </div>
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

  .setup-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 18px;
    margin-top: 24px;
    font-size: 12px;
    color: var(--txt-sec);
  }

  .setup-nav a {
    text-decoration: underline;
    text-underline-offset: 4px;
  }

  .needs li::before {
    content: '·';
    margin-right: 10px;
    color: var(--txt-muted);
  }

  .use {
    padding-bottom: 128px;
  }

  .setup {
    padding-bottom: 64px;
  }

  .setup-card {
    display: grid;
    gap: 16px;
    padding: 28px;
  }

  .setup-card p:not(.eyebrow) {
    font-size: 14px;
    line-height: 1.7;
    color: var(--txt-muted);
  }

  .setup-card a {
    font-size: 13px;
    color: var(--txt-sec);
    text-decoration: underline;
    text-underline-offset: 4px;
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
