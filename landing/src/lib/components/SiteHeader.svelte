<script lang="ts">
  import { links } from '$lib/links';
</script>

<header>
  <div class="wrap inner">
    <a class="brand" href="/" aria-label="Algoria home"><img src="/favicon.svg" alt="" width="22" height="22" />Algoria</a>
    <nav aria-label="Main navigation">
      <a class="how" href="/#how">How it works</a>
      <a class="how" href="/how-to-use">How to use</a>
      <a href={links.github} target="_blank" rel="noopener noreferrer">GitHub</a>
      <a class="cta" href="/how-to-use#install">Install</a>
    </nav>
  </div>
</header>

<style>
  header {
    position: sticky;
    top: 0;
    z-index: 10;
    border-bottom: 1px solid var(--border);
    background: var(--header-bg);
    -webkit-backdrop-filter: blur(14px);
    backdrop-filter: blur(14px);
  }

  .inner {
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    font-size: 15px;
    font-weight: 600;
  }

  .brand img {
    border-radius: 6px;
  }

  nav {
    display: flex;
    align-items: center;
    gap: 28px;
    font-size: 13px;
    color: var(--txt-muted);
  }

  nav a {
    transition: color 0.15s;
  }

  nav a:hover {
    color: var(--txt);
  }

  .cta {
    padding: 6px 12px;
    border: 1px solid var(--border-strong);
    border-radius: 9px;
    background: var(--active-bg);
    color: var(--txt);
    font-weight: 500;
  }

  @media (max-width: 560px) {
    nav {
      gap: 18px;
    }

    .how {
      display: none;
    }
  }
</style>
