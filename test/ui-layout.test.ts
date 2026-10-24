import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The dashboard ships minified markup, so adjacent buttons have no whitespace between them and any
// button row without an explicit gap renders the controls fused together. These tests pin the gap
// on every horizontal button row so a new row cannot regress into that state.
const stylesheet = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function ruleBody(selector: string): string | undefined {
  for (const match of stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map(part => part.trim());
    if (selectors.includes(selector)) return match[2];
  }
  return undefined;
}

function hasGap(selector: string): boolean {
  const body = ruleBody(selector);
  return body !== undefined && /\bgap:\s*(?!0[;\s])/.test(body);
}

describe('dashboard layout contracts', () => {
  it.each(['.detail-dialog footer', '.drawer-footer', '.test-actions', '.row-actions', '.backup-actions'])(
    'keeps %s siblings apart with an explicit gap',
    selector => {
      expect(ruleBody(selector), `${selector} rule is missing`).toBeDefined();
      expect(hasGap(selector), `${selector} needs a non-zero gap`).toBe(true);
    }
  );
  it('covers every dialog footer that holds more than one button', () => {
    const multiButtonDialogs = [...html.matchAll(/<dialog\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/dialog>/g)]
      .filter(([, , body]) => {
        const footer = body.match(/<footer[^>]*>([\s\S]*?)<\/footer>/);
        return footer !== null && (footer[1].match(/<button/g) ?? []).length > 1;
      })
      .map(([, classList]) => classList.split(/\s+/).filter(Boolean));
    expect(multiButtonDialogs.length).toBeGreaterThan(0);
    for (const classes of multiButtonDialogs) {
      const spaced = classes.some(name => hasGap(`.${name} footer`));
      expect(spaced, `dialog .${classes.join('.')} has a multi-button footer without a gap rule`).toBe(true);
    }
  });
  // The dialog body has no padding of its own in the base rules, so without this it butts against the
  // borders while header and footer sit on 24px.
  it('pads the secret dialog body to match its header and footer', () => {
    const body = ruleBody('.secret-dialog-body');
    expect(body, '.secret-dialog-body rule is missing').toBeDefined();
    expect(body).toMatch(/padding:\s*var\(--sp-\d\)\s+var\(--sp-\d\)/);
  });
});
