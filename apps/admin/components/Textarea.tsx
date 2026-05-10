'use client';

import type { TextareaHTMLAttributes } from 'react';

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  helperText?: string;
  errorText?: string;
}

export function Textarea({
  label,
  helperText,
  errorText,
  id,
  className = '',
  ...props
}: TextareaProps) {
  const textareaId = id ?? label.toLowerCase().replace(/\s+/g, '-');
  const helperId = helperText ? `${textareaId}-helper` : undefined;
  const errorId = errorText ? `${textareaId}-error` : undefined;
  const describedBy =
    [helperId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={textareaId}
        className="text-sm font-medium text-gray-900"
      >
        {label}
      </label>
      <textarea
        id={textareaId}
        aria-describedby={describedBy}
        aria-invalid={errorText ? true : undefined}
        rows={4}
        {...props}
        className={[
          'block w-full rounded border px-3 py-1.5 text-sm text-gray-900',
          'border-gray-300 bg-white placeholder:text-gray-400 resize-y',
          'focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600',
          'disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed',
          errorText ? 'border-red-500 focus:ring-red-500 focus:border-red-500' : '',
          className,
        ]
          .join(' ')
          .trim()}
      />
      {helperText && !errorText && (
        <p id={helperId} className="text-xs text-gray-500">
          {helperText}
        </p>
      )}
      {errorText && (
        <p id={errorId} role="alert" className="text-xs text-red-600">
          {errorText}
        </p>
      )}
    </div>
  );
}
