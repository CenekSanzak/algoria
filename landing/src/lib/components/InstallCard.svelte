<script lang="ts">
  import CodeBlock from './CodeBlock.svelte';

  type Snippet = { code: string; label: string; variant?: 'block' | 'ask' | 'line' };
  type Stage = { marker: string; title: string; snippets: Snippet[]; hint?: boolean };
  type Client = { id: string; name: string; stages: Stage[] };

  // Keep in sync with agent-skills/README.md (marketplace name and CLI commands).
  const firstPrompt: Snippet = { code: 'Set up my Algoria wallet and top up 200 TRY.', label: 'Copy prompt', variant: 'ask' };

  const clients: Client[] = [
    {
      id: 'claude',
      name: 'Claude Code',
      stages: [
        {
          marker: '1',
          title: 'Add the plugin in Claude Code',
          snippets: [{ code: '/plugin marketplace add CenekSanzak/algoria\n/plugin install algoria@algoria-skills', label: 'Copy install commands' }]
        },
        { marker: '2', title: 'Ask', snippets: [firstPrompt] }
      ]
    },
    {
      id: 'codex',
      name: 'Codex',
      stages: [
        {
          marker: '1',
          title: 'Add the plugin from your terminal',
          snippets: [{ code: 'codex plugin marketplace add CenekSanzak/algoria\ncodex plugin add algoria@algoria-skills', label: 'Copy install commands' }]
        },
        { marker: '2', title: 'Start a new Codex session and ask', snippets: [firstPrompt] }
      ]
    },
    {
      id: 'npx',
      name: 'npx',
      stages: [
        {
          marker: '›',
          title: 'Paste into Claude Code or Codex, one line at a time',
          hint: true,
          snippets: [
            { code: '! npx algoria wallet onboard --network testnet', label: 'Copy wallet command', variant: 'line' },
            { code: '! npx algoria topup start --try 200', label: 'Copy top-up command', variant: 'line' },
            { code: '! npx algoria discover search image', label: 'Copy discover command', variant: 'line' }
          ]
        }
      ]
    }
  ];

  let selected = $state(0);
  const tabs: HTMLButtonElement[] = [];

  function onKeydown(event: KeyboardEvent) {
    const step = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[event.key];
    if (!step) return;
    selected = (selected + step + clients.length) % clients.length;
    tabs[selected]?.focus();
  }
</script>

<div class="card install rise" id="install">
  <div class="head">
    <span class="title">Connect</span>
    <div class="segmented" role="tablist" aria-label="Choose where to install" tabindex="-1" onkeydown={onKeydown}>
      {#each clients as client, i (client.id)}
        <button
          bind:this={tabs[i]}
          role="tab"
          id="tab-{client.id}"
          aria-controls="panel-{client.id}"
          aria-selected={selected === i}
          tabindex={selected === i ? 0 : -1}
          onclick={() => (selected = i)}>{client.name}</button
        >
      {/each}
    </div>
  </div>

  {#each clients as client, i (client.id)}
    <div class="panel" role="tabpanel" id="panel-{client.id}" aria-labelledby="tab-{client.id}" hidden={selected !== i}>
      {#each client.stages as stage (stage.title)}
        <div>
          <p class="stage-label"><span>{stage.marker}</span>{stage.title}</p>
          <div class="snippets">
            {#each stage.snippets as snippet (snippet.code)}
              <CodeBlock {...snippet} />
            {/each}
          </div>
          {#if stage.hint}
            <p class="hint"><code>!</code> runs the line as a shell command in the chat. Drop it in a plain terminal. Node.js 22+.</p>
          {/if}
        </div>
      {/each}
    </div>
  {/each}

  <div class="foot"><span class="live-dot" aria-hidden="true"></span>Live on Stellar testnet</div>
</div>

<style>
  .install {
    min-width: 0;
    overflow: hidden;
    animation-delay: 0.08s;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }

  .title {
    font-size: 13px;
    font-weight: 500;
    color: var(--txt-sec);
  }

  .segmented {
    display: flex;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--well);
  }

  [role='tab'] {
    padding: 5px 11px;
    border: 0;
    border-radius: 7px;
    background: none;
    font-size: 12px;
    font-weight: 500;
    color: var(--txt-muted);
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }

  [role='tab']:hover {
    color: var(--txt-sec);
  }

  [role='tab'][aria-selected='true'] {
    background: var(--elevated);
    color: var(--txt);
    box-shadow: inset 0 1px 0 var(--spec), 0 1px 2px #0003;
  }

  .panel {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 18px;
    padding: 18px 16px 20px;
    animation: fade 0.25s ease;
  }

  .panel[hidden] {
    display: none;
  }

  .stage-label {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 9px;
    font-size: 12px;
    color: var(--txt-muted);
  }

  .stage-label span {
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    flex-shrink: 0;
    border: 1px solid var(--border-strong);
    border-radius: 50%;
    font: 500 10px var(--mono);
    color: var(--txt-sec);
  }

  .snippets {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }

  .hint {
    margin-top: 12px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--txt-muted);
  }

  .hint code {
    padding: 1px 5px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--well);
    font: 11px var(--mono);
    color: var(--txt-sec);
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 11px 16px;
    border-top: 1px solid var(--border);
    font: 11px var(--mono);
    color: var(--txt-muted);
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
  }

  @media (max-width: 560px) {
    .head {
      flex-direction: column;
      align-items: stretch;
      gap: 12px;
    }

    [role='tab'] {
      flex: 1;
    }
  }
</style>
