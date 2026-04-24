import { useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

export function DeleteConfirm({ open, onClose, onConfirm, itemName, itemType = 'agent' }) {
  const [typed, setTyped] = useState('');

  const handleClose = () => { setTyped(''); onClose(); };
  const handleConfirm = () => { if (typed === itemName) { onConfirm(); handleClose(); } };

  return (
    <Modal open={open} onClose={handleClose} title={`Delete ${itemType}`} size="sm">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-gray-400">
          This action cannot be undone. Type <span className="font-mono text-gray-200 bg-gray-800 px-1 rounded">{itemName}</span> to confirm.
        </p>
        <Input
          value={typed}
          onChange={e => setTyped(e.target.value)}
          placeholder={itemName}
          onKeyDown={e => e.key === 'Enter' && handleConfirm()}
          autoFocus
        />
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={handleClose}>Cancel</Button>
          <Button variant="danger" onClick={handleConfirm} disabled={typed !== itemName}>
            Delete
          </Button>
        </div>
      </div>
    </Modal>
  );
}
