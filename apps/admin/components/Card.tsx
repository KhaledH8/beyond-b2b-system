import type { ReactNode } from 'react';

export interface CardProps {
  title?: string;
  children: ReactNode;
  className?: string;
}

export function Card({ title, children, className = '' }: CardProps) {
  return (
    <div
      className={['rounded-lg border border-gray-200 bg-white shadow-sm', className]
        .join(' ')
        .trim()}
    >
      {title && (
        <div className="border-b border-gray-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        </div>
      )}
      <div className="px-4 py-4">{children}</div>
    </div>
  );
}
