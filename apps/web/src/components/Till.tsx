import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, post } from '../api';
import { fmt, toMinor } from '../format';
import { Button, Dialog, ErrorBanner, Field, Input } from './ui';

/** The signed-in user's open till at a branch (null when none). Expected cash is hidden from non-supervisors (blind count). */
export function useTill(branchId: string) {
  return useQuery({ queryKey: ['till', branchId], enabled: !!branchId, queryFn: async () => (await get(`/cash-shifts/current?branchId=${branchId}`)).shift });
}

export function OpenTillDialog({ branchId, onClose, onOpened }: { branchId: string; onClose: () => void; onOpened?: () => void }) {
  const qc = useQueryClient(); const [float, setFloat] = useState('');
  const m = useMutation({ mutationFn: () => post('/cash-shifts', { branchId, openingFloatMinor: toMinor(float || '0') }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['till'] }); onOpened?.(); onClose(); } });
  return (
    <Dialog title="Open your till" onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <ErrorBanner error={m.error} />
        <Field label="Cash in the drawer ($)" hint="Count the starting float and enter it">{(id) => <Input id={id} inputMode="decimal" required autoFocus value={float} onChange={(e) => setFloat(e.target.value.replace(/[^0-9.]/g, ''))} />}</Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={m.isPending} disabled={float === ''}>Open till ({float ? fmt(toMinor(float)) : '$0.00'})</Button></div>
      </form>
    </Dialog>
  );
}
