<script lang="ts">
  import { links } from '$lib/links';
  import ThemeToggle from './ThemeToggle.svelte';
</script>

<footer class="wrap">
  <span class="brand"><img src="/favicon.svg" alt="" width="18" height="18" />Algoria — on Stellar</span>
  <nav aria-label="Footer">
    <a href={links.github} target="_blank" rel="noopener noreferrer">GitHub</a>
    <a href={links.npm} target="_blank" rel="noopener noreferrer">npm</a>
    <a href={links.listService} target="_blank" rel="noopener noreferrer">List a service</a>
  </nav>
  <div class="end">
    <ThemeToggle />
  </div>
</footer>

<style>
  footer {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 24px;
    padding-block: 22px 30px;
    border-top: 1px solid var(--border);
    font: 11px var(--mono);
    color: var(--txt-muted);
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: 9px;
  }

  .brand img {
    border-radius: 5px;
  }

  nav {
    display: flex;
    gap: 22px;
  }

  nav a:hover {
    color: var(--txt);
  }

  .end {
    justify-self: end;
    display: inline-flex;
    align-items: center;
    gap: 14px;
  }

  @media (max-width: 900px) {
    footer {
      grid-template-columns: 1fr auto;
    }

    nav {
      grid-column: 1 / -1;
      grid-row: 2;
    }
  }

  @media (max-width: 560px) {
    footer {
      grid-template-columns: 1fr;
      gap: 14px;
    }

    .end {
      justify-self: start;
    }
  }
</style>
