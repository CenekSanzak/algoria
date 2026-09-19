<script lang="ts">
  import { links, site } from '$lib/links';
  import InstallCard from '$lib/components/InstallCard.svelte';
  import CodeBlock from '$lib/components/CodeBlock.svelte';

  // Keep in sync with agent-skills/README.md and `npx algoria <group>` help.
  type Step = { title: string; body: string; ask: string; commands: string[] };
  const steps: Step[] = [
    {
      title: 'Create your wallet',
      body: 'A Stellar wallet is made on your machine. The secret key never leaves it.',
      ask: 'Set up my Algoria wallet.',
      commands: ['npx algoria wallet onboard --network testnet', 'npx algoria wallet balance']
    },
    {
      title: 'Top up in lira',
      body: 'You get an IBAN, an amount and a reference. Send the TRY transfer and it arrives as USDC.',
      ask: 'Top up 200 TRY.',
      commands: ['npx algoria topup start --try 200', 'npx algoria topup status --wait']
    },
    {
      title: 'Set a budget',
      body: 'Your assistant can only spend inside a budget you approve, with a limit for each request.',
      ask: 'Let Algoria spend up to 0.10 USDC, at most 0.02 per request.',
      commands: ['npx algoria pay budget --name demo --total 0.10 --per-call 0.02']
    },
    {
      title: 'Find a service',
      body: 'Search the catalog for images, voice, video and more. See the price before you pay.',
      ask: 'What image services can I use?',
      commands: ['npx algoria discover search image', 'npx algoria discover show image.generate']
    },
    {
      title: 'Ask for the result',
      body: 'The assistant gets a quote, pays per request on Stellar and saves the result for you.',
      ask: 'Make an image of a small red sailboat at sunset.',
      commands: [
        'npx algoria pay quote image.generate --input input.json --budget demo',
        'npx algoria pay run <job-id> --approve',
        'npx algoria pay status <job-id> --wait'
      ]
    }
  ];
</script>

<svelte:head>
  <title>How to use — Algoria</title>
  <meta name="description" content="Install Algoria in Claude Code or Codex, top up in Turkish lira and buy AI services. Every step also works from the terminal with npx." />
  <link rel="canonical" href="{site.url}how-to-use" />
</svelte:head>

<section class="wrap intro" aria-labelledby="page-title">
  <div class="copy rise">
    <p class="eyebrow">How to use</p>
    <h1 id="page-title">Set up once.<br /><span class="silver">Then just ask.</span></h1>
    <p class="lead">
      Install the plugin in Claude Code or Codex, then talk to your assistant as usual. Prefer a terminal? Every step
      has an <code>npx algoria</code> command too.
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
    <h2 id="use-title">Ask your assistant, or run it yourself.</h2>
  </div>

  <ol class="card steps">
    {#each steps as step, i (step.title)}
      <li>
        <div class="info">
          <span class="num">{String(i + 1).padStart(2, '0')}</span>
          <h3>{step.title}</h3>
          <p>{step.body}</p>
        </div>
        <div class="ways">
          <div>
            <p class="label">Ask in Claude Code or Codex</p>
            <CodeBlock code={step.ask} label="Copy prompt" variant="ask" />
          </div>
          <div>
            <p class="label">Or run in a terminal</p>
            <div class="lines">
              {#each step.commands as command (command)}
                <CodeBlock code={command} label="Copy command" variant="line" />
              {/each}
            </div>
          </div>
        </div>
      </li>
    {/each}
  </ol>

  <p class="note">
    Inside Claude Code or Codex, start a line with <code>!</code> to run it as a shell command. Run
    <code>npx algoria</code> on its own to see every command, or read the
    <a href={links.github} target="_blank" rel="noopener noreferrer">docs on GitHub</a>.
  </p>
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

  code {
    padding: 1px 5px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--well);
    font: 12px var(--mono);
    color: var(--txt-sec);
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
    grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
    gap: 40px;
    padding: 28px;
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
    margin-top: 14px;
    font-size: 16px;
    font-weight: 500;
  }

  .info p {
    margin-top: 8px;
    max-width: 320px;
    font-size: 14px;
    line-height: 1.65;
    color: var(--txt-muted);
  }

  .ways {
    display: grid;
    gap: 16px;
    min-width: 0;
  }

  .label {
    margin-bottom: 8px;
    font-size: 12px;
    color: var(--txt-muted);
  }

  .lines {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }

  .note {
    margin-top: 20px;
    font-size: 13px;
    line-height: 1.7;
    color: var(--txt-muted);
  }

  .note a {
    color: var(--txt-sec);
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-color: var(--border-strong);
  }

  @media (max-width: 900px) {
    .intro {
      grid-template-columns: 1fr;
      gap: 48px;
      padding-block: 64px 80px;
    }

    .steps li {
      grid-template-columns: 1fr;
      gap: 20px;
      padding: 22px;
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
      padding: 20px 16px;
    }
  }
</style>
