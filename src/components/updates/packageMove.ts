/** The package the phone app was first published under. */
export const OLD_PACKAGE = 'io.universaldownloader.app';
/** The one it moved to. Both run the same code; keep in sync with `BridgePlugin.MOVE_PACKAGES`. */
export const NEW_PACKAGE = 'app.umdplus';

export interface PackageStatus {
  package: string;
  installed: string[];
}

/**
 * What the move asks of this copy:
 * - `removeOld`: this is the new app and the old one is still installed.
 * - `moved`: this is the old app and the new one is installed, so this copy
 *   has nothing left to do but hand over.
 * - `null`: nothing.
 */
export type PackageMove = 'removeOld' | 'moved' | null;

export function packageMove(status: PackageStatus | null): PackageMove {
  if (!status) return null;
  if (status.package === NEW_PACKAGE && status.installed.includes(OLD_PACKAGE)) return 'removeOld';
  if (status.package === OLD_PACKAGE && status.installed.includes(NEW_PACKAGE)) return 'moved';
  return null;
}
