import { upsertEnvArn, findExactImage, selectVersionsToDelete } from '../scripts/build-microvm-image';

// ── upsertEnvArn ─────────────────────────────────────────────────────────────

describe('upsertEnvArn', () => {
  const arn = 'arn:aws:lambda:eu-west-1:123456789012:microvm-image:github-runner-docker';
  const arnV2 = 'arn:aws:lambda:eu-west-1:123456789012:microvm-image:github-runner-docker-v2';
  const arnNoDocker = 'arn:aws:lambda:eu-west-1:123456789012:microvm-image:github-runner-no-docker';

  describe('MICROVM_IMAGE_ARN_DOCKER', () => {
    const key = 'MICROVM_IMAGE_ARN_DOCKER';

    test('appends line when .env is empty', () => {
      const result = upsertEnvArn('', key, arn);
      expect(result).toBe(`${key}=${arn}\n`);
    });

    test('appends line when key is absent', () => {
      const result = upsertEnvArn('SOME_OTHER_VAR=foo\n', key, arn);
      expect(result).toBe(`SOME_OTHER_VAR=foo\n${key}=${arn}\n`);
    });

    test('replaces existing key line in place', () => {
      const existing = `SOME_VAR=bar\n${key}=old-arn\nANOTHER_VAR=baz\n`;
      const result = upsertEnvArn(existing, key, arn);
      expect(result).toBe(`SOME_VAR=bar\n${key}=${arn}\nANOTHER_VAR=baz\n`);
    });

    test('does not duplicate the key on repeated calls', () => {
      const first = upsertEnvArn('', key, arn);
      const second = upsertEnvArn(first, key, arnV2);
      const occurrences = (second.match(new RegExp(`^${key}=`, 'gm')) ?? []).length;
      expect(occurrences).toBe(1);
    });

    test('preserves all other lines when replacing', () => {
      const existing = `FOO=1\n${key}=old\nBAR=2\n`;
      const result = upsertEnvArn(existing, key, arn);
      expect(result).toContain('FOO=1');
      expect(result).toContain('BAR=2');
      expect(result).toContain(`${key}=${arn}`);
      expect(result).not.toContain(`${key}=old`);
    });
  });

  describe('MICROVM_IMAGE_ARN_NO_DOCKER', () => {
    const key = 'MICROVM_IMAGE_ARN_NO_DOCKER';

    test('appends line when .env is empty', () => {
      const result = upsertEnvArn('', key, arnNoDocker);
      expect(result).toBe(`${key}=${arnNoDocker}\n`);
    });

    test('appends line alongside an existing docker key', () => {
      const existing = `MICROVM_IMAGE_ARN_DOCKER=${arn}\n`;
      const result = upsertEnvArn(existing, key, arnNoDocker);
      expect(result).toContain(`MICROVM_IMAGE_ARN_DOCKER=${arn}`);
      expect(result).toContain(`${key}=${arnNoDocker}`);
    });

    test('replaces existing no-docker key line in place', () => {
      const existing = `MICROVM_IMAGE_ARN_DOCKER=${arn}\n${key}=old-arn\n`;
      const result = upsertEnvArn(existing, key, arnNoDocker);
      expect(result).toBe(`MICROVM_IMAGE_ARN_DOCKER=${arn}\n${key}=${arnNoDocker}\n`);
    });

    test('does not duplicate the key on repeated calls', () => {
      const first = upsertEnvArn('', key, arnNoDocker);
      const second = upsertEnvArn(first, key, arnNoDocker + '-v2');
      const occurrences = (second.match(new RegExp(`^${key}=`, 'gm')) ?? []).length;
      expect(occurrences).toBe(1);
    });

    test('does not touch MICROVM_IMAGE_ARN_DOCKER when upserting no-docker key', () => {
      const existing = `MICROVM_IMAGE_ARN_DOCKER=${arn}\n`;
      const result = upsertEnvArn(existing, key, arnNoDocker);
      expect(result).toContain(`MICROVM_IMAGE_ARN_DOCKER=${arn}`);
    });
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

// ── selectVersionsToDelete ───────────────────────────────────────────────────

describe('selectVersionsToDelete', () => {
  test('returns all versions except the one to keep', () => {
    const versions = [
      { imageVersion: 'v1' },
      { imageVersion: 'v2' },
      { imageVersion: 'v3' },
    ];
    expect(selectVersionsToDelete(versions, 'v3')).toEqual(['v1', 'v2']);
  });

  test('drops items whose imageVersion is undefined', () => {
    const versions = [
      { imageVersion: 'v1' },
      { imageVersion: undefined },
      { imageVersion: 'v3' },
    ];
    expect(selectVersionsToDelete(versions, 'v3')).toEqual(['v1']);
  });

  test('returns empty array when list is empty', () => {
    expect(selectVersionsToDelete([], 'v1')).toEqual([]);
  });

  test('returns empty array when the only version is the one to keep', () => {
    expect(selectVersionsToDelete([{ imageVersion: 'v1' }], 'v1')).toEqual([]);
  });

  test('returns empty array (delete nothing) when keepVersion is falsy', () => {
    const versions = [{ imageVersion: 'v1' }, { imageVersion: 'v2' }];
    expect(selectVersionsToDelete(versions, '')).toEqual([]);
  });
});
