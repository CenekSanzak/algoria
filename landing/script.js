const copyButton = document.querySelector('.copy-button');
const copyStatus = document.querySelector('#copy-status');
const discoveryCommand = "curl --request GET 'https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/discovery/resources'";
let resetTimer;

copyButton?.addEventListener('click', async () => {
  const label = copyButton.querySelector('span');
  try {
    await navigator.clipboard.writeText(discoveryCommand);
    label.textContent = 'Copied';
    copyStatus.textContent = 'Discovery request copied to clipboard.';
  } catch {
    label.textContent = 'Select code';
    copyStatus.textContent = 'Copy is unavailable. Select and copy the discovery request.';
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('.request-code'));
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  clearTimeout(resetTimer);
  resetTimer = setTimeout(() => { label.textContent = 'Copy'; }, 2400);
});
