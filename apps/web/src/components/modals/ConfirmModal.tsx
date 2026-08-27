/**
 * Generic confirmation dialog.
 *
 * The confirm handler may be async; the button stays in a loading state until it settles,
 * and the dialog only closes on success. A failed delete that silently dismissed the
 * dialog would leave the user believing it worked.
 */

import { useState } from 'react';
import { useUiStore } from '../../store/useUiStore';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/primitives';

export function ConfirmModal({
  title,
  body,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useUiStore((s) => s.toast);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'That did not work';
      setError(message);
      toast(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={title}
      hideClose={busy}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={() => void run()}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-[14px] leading-relaxed text-ink-dim">{body}</p>
      {error && (
        <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}
