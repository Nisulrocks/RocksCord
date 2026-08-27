/**
 * Single mount point for every modal.
 *
 * Which modal is open is a discriminated union in the UI store, so exactly one can be
 * open at a time and each one's props are type-checked at the call site that opens it.
 */

import { useUiStore } from '../../store/useUiStore';
import { CreateServerModal } from './CreateServerModal';
import { JoinServerModal } from './JoinServerModal';
import { CreateChannelModal } from './CreateChannelModal';
import { ChannelSettingsModal } from './ChannelSettingsModal';
import { ServerSettingsModal } from './ServerSettingsModal';
import { UserSettingsModal } from './UserSettingsModal';
import { InviteModal } from './InviteModal';
import { SearchModal } from './SearchModal';
import { ImageViewerModal } from './ImageViewerModal';
import { ConfirmModal } from './ConfirmModal';

export function ModalHost() {
  const modal = useUiStore((s) => s.modal);
  const close = useUiStore((s) => s.closeModal);

  if (!modal) return null;

  switch (modal.kind) {
    case 'create-server':
      return <CreateServerModal onClose={close} />;
    case 'join-server':
      return <JoinServerModal onClose={close} />;
    case 'create-channel':
      return (
        <CreateChannelModal serverId={modal.serverId} initialType={modal.type} onClose={close} />
      );
    case 'channel-settings':
      return <ChannelSettingsModal channelId={modal.channelId} onClose={close} />;
    case 'server-settings':
      return (
        <ServerSettingsModal serverId={modal.serverId} initialTab={modal.tab} onClose={close} />
      );
    case 'user-settings':
      return <UserSettingsModal initialTab={modal.tab} onClose={close} />;
    case 'invite':
      return <InviteModal serverId={modal.serverId} onClose={close} />;
    case 'search':
      return (
        <SearchModal serverId={modal.serverId} channelId={modal.channelId} onClose={close} />
      );
    case 'image':
      return <ImageViewerModal url={modal.url} fileName={modal.fileName} onClose={close} />;
    case 'confirm':
      return (
        <ConfirmModal
          title={modal.title}
          body={modal.body}
          confirmLabel={modal.confirmLabel}
          danger={modal.danger}
          onConfirm={modal.onConfirm}
          onClose={close}
        />
      );
    default:
      return null;
  }
}
