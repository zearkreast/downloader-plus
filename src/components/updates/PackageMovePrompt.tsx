import { useState } from 'react';

import { Button } from '@/components/ui/Button';
import { InlineNotice } from '@/components/ui/InlineNotice';
import { Modal } from '@/components/ui/Modal';
import { useTranslation } from '@/i18n';
import * as ipc from '@/services/ipc';
import { NEW_PACKAGE, OLD_PACKAGE, type PackageMove } from './packageMove';

/**
 * The phone app's move to a new package, which Android installs beside the
 * old one rather than over it.
 */
export function PackageMovePrompt({ move, onClose }: { move: Exclude<PackageMove, null>; onClose: () => void }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);

  const run = (call: Promise<void>) => {
    setFailed(false);
    void call.then(onClose, () => setFailed(true));
  };

  const removeOld = move === 'removeOld';
  return (
    <Modal
      open
      onClose={onClose}
      title={t(removeOld ? 'move.removeOldTitle' : 'move.movedTitle')}
      description={t(removeOld ? 'move.removeOldBody' : 'move.movedBody')}
      closeLabel={t('common.close')}
      footer={
        removeOld ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('move.later')}
            </Button>
            <Button variant="primary" onClick={() => run(ipc.platformUninstallPackage(OLD_PACKAGE))}>
              {t('move.removeOld')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => run(ipc.platformUninstallPackage(OLD_PACKAGE))}>
              {t('move.removeThis')}
            </Button>
            <Button variant="primary" onClick={() => run(ipc.platformOpenPackage(NEW_PACKAGE))}>
              {t('move.openNew')}
            </Button>
          </>
        )
      }
    >
      {failed && <InlineNotice tone="error">{t('move.failed')}</InlineNotice>}
    </Modal>
  );
}
