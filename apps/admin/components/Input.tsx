'use client';

import type { InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  helperText?: string;
  errorText?: string;
}

export function Input({
  label,
  helperText,
  errorText,
  id,
  className = '',
  ...props
}: InputProps) {
  const inputId = id ?? label.toLowerCase().replace(/\s+/g, '-');
  const helperId = helperText ? `${inputId}-helper` : undefined;
  const errorId = errorText ? `${inputId}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={inputId}
        className="text-sm font-medium text-gray-900"
      >
        {label}
      </label>
      <input
        id={inputId}
        aria-describedby={describedBy}
        aria-invalid={errorText ? true : undefined}
        {...props}
        className={[
          'block w-full rounded border px-3 py-1.5 text-sm text-gray-900',
          'border-gray-300 bg-white placeholder:text-gray-400',
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
