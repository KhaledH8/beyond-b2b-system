import type { ReactNode } from 'react';

export interface HeaderProps {
  displayName: string;
  actions?: ReactNode;
}

export function Header({ displayName, actions }: HeaderProps) {
  return (
    <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-semibold text-gray-900">Beyond Borders</span>
        <span className="text-gray-300">/</span>
        <span className="text-gray-500">Admin</span>
      </div>

      <div className="flex items-center gap-4">
        {actions}
        <span className="text-sm text-gray-700" aria-label="Signed in as">
          {displayName}
        </span>
        <a
          href="/auth/logout"
          className="text-sm text-gray-500 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 rounded"
        >
          Sign out
        </a>
      </div>
    </header>
  );
}
