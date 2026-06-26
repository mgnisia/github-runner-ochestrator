import { upsertEnvArn, findExactImage } from '../scripts/build-microvm-image';

// ── upsertEnvArn ─────────────────────────────────────────────────────────────

describe('upsertEnvArn', () => {
  const arn = 'arn:aws:lambda:eu-west-1:123456789012:microvm-image:github-runner';

  test('appends line when .env is empty', () => {
    const result = upsertEnvArn('', arn);
    expect(result).toBe(`MICROVM_IMAGE_ARN=${arn}\n`);
  });

  test('appends line when key is absent', () => {
    const result = upsertEnvArn('SOME_OTHER_VAR=foo\n', arn);
    expect(result).toBe(`SOME_OTHER_VAR=foo\nMICROVM_IMAGE_ARN=${arn}\n`);
  });

  test('replaces existing MICROVM_IMAGE_ARN line in place', () => {
    const existing = `SOME_VAR=bar\nMICROVM_IMAGE_ARN=old-arn\nANOTHER_VAR=baz\n`;
    const result = upsertEnvArn(existing, arn);
    expect(result).toBe(`SOME_VAR=bar\nMICROVM_IMAGE_ARN=${arn}\nANOTHER_VAR=baz\n`);
  });

  test('does not duplicate the key on repeated calls', () => {
    const first = upsertEnvArn('', arn);
    const second = upsertEnvArn(first, 'arn:aws:lambda:eu-west-1:123456789012:microvm-image:github-runner-v2');
    const occurrences = (second.match(/^MICROVM_IMAGE_ARN=/gm) ?? []).length;
    expect(occurrences).toBe(1);
  });

  test('preserves all other lines when replacing', () => {
    const existing = `FOO=1\nMICROVM_IMAGE_ARN=old\nBAR=2\n`;
    const result = upsertEnvArn(existing, arn);
    expect(result).toContain('FOO=1');
    expect(result).toContain('BAR=2');
    expect(result).toContain(`MICROVM_IMAGE_ARN=${arn}`);
    expect(result).not.toContain('MICROVM_IMAGE_ARN=old');
  });
});

// ── findExactImage ────────────────────────────────────────────────────────────

describe('findExactImage', () => {
  const items = [
    { name: 'github-runner', imageArn: 'arn:aws:...microvm-image:github-runner' },
    { name: 'github-runner-2', imageArn: 'arn:aws:...microvm-image:github-runner-2' },
    { name: 'other-image', imageArn: 'arn:aws:...microvm-image:other-image' },
  ];

  test('returns the item with an exactly matching name', () => {
    const result = findExactImage(items, 'github-runner');
    expect(result).toBeDefined();
    expect(result!.name).toBe('github-runner');
    expect(result!.imageArn).toBe('arn:aws:...microvm-image:github-runner');
  });

  test('does not match a substring-only name (e.g. github-runner-2)', () => {
    // nameFilter from the API is a substring filter; findExactImage must do an exact check
    const subsetItems = [{ name: 'github-runner-2', imageArn: 'arn:aws:...microvm-image:github-runner-2' }];
    const result = findExactImage(subsetItems, 'github-runner');
    expect(result).toBeUndefined();
  });

  test('returns undefined when the list is empty', () => {
    expect(findExactImage([], 'github-runner')).toBeUndefined();
  });

  test('returns undefined when no item matches the target name', () => {
    expect(findExactImage(items, 'nonexistent-image')).toBeUndefined();
  });

  test('matches correctly when item has no imageArn (optional field)', () => {
    const sparse = [{ name: 'github-runner' }];
    const result = findExactImage(sparse, 'github-runner');
    expect(result).toBeDefined();
    expect(result!.name).toBe('github-runner');
  });
});
