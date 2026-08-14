import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/storage/db';
import { WorkspaceStore } from '@/lib/workspace/storage';
import { WorkspaceView } from './WorkspaceView';

beforeEach(async () => {
  vi.stubGlobal('navigator', {
    storage: { estimate: vi.fn(async () => ({ usage: 0, quota: 500 * 1024 * 1024 })) },
  });
  await db.delete();
  await db.open();
});

afterAll(async () => db.delete());

describe('WorkspaceView', () => {
  it('shows an empty state without a conversation', () => {
    render(<WorkspaceView conversationId={null} />);
    expect(screen.getByText(/先创建或打开一个会话/u)).toBeInTheDocument();
  });

  it('lists and previews current conversation text artifacts', async () => {
    await new WorkspaceStore().write('conversation-a', '/summary.md', '# Local artifact');
    render(<WorkspaceView conversationId="conversation-a" />);
    fireEvent.click(await screen.findByTitle('/summary.md'));
    expect(await screen.findByText('# Local artifact')).toBeInTheDocument();
    expect(screen.getByText(/text\/markdown/u)).toBeInTheDocument();
  });

  it('deletes an artifact after user confirmation', async () => {
    const store = new WorkspaceStore();
    await store.write('conversation-a', '/delete.txt', 'delete me');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<WorkspaceView conversationId="conversation-a" />);
    fireEvent.click(await screen.findByLabelText('删除 delete.txt'));
    await waitFor(() => expect(screen.queryByTitle('/delete.txt')).not.toBeInTheDocument());
  });
});
