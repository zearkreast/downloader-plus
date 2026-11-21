import { describe, expect, test } from 'vitest';

import { NEW_PACKAGE, OLD_PACKAGE, packageMove } from './packageMove';

describe('packageMove', () => {
  test('the new app offers to remove the old one while it is installed', () => {
    expect(packageMove({ package: NEW_PACKAGE, installed: [OLD_PACKAGE] })).toBe('removeOld');
    expect(packageMove({ package: NEW_PACKAGE, installed: [] })).toBeNull();
  });

  test('the old app hands over once the new one is installed', () => {
    expect(packageMove({ package: OLD_PACKAGE, installed: [NEW_PACKAGE] })).toBe('moved');
    expect(packageMove({ package: OLD_PACKAGE, installed: [] })).toBeNull();
  });

  test('a debug build or the desktop asks nothing', () => {
    expect(packageMove({ package: 'io.universaldownloader.app.debug', installed: [OLD_PACKAGE] })).toBeNull();
    expect(packageMove(null)).toBeNull();
  });
});
