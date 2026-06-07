'use client';

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type ReactNode
} from 'react';

/**
 * Linear 风原子组件库。
 * 设计原则：
 *  - 单一强调色 #5E6AD2（Linear 蓝紫）
 *  - 中性色采用 zinc 阶（边框 zinc-200、次文字 zinc-500、主文字 zinc-950）
 *  - 圆角统一 6/8/12 三档（按钮 6，卡片 8，容器 12）
 *  - 阴影几乎不用，靠 1px border 区分层级
 *  - 控件高度 32px (sm) / 36px (md，默认) / 40px (lg)
 */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const buttonBase =
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5E6AD2]/40 disabled:cursor-not-allowed disabled:opacity-50';

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-zinc-950 text-white hover:bg-zinc-800',
  secondary: 'border border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50',
  ghost: 'text-zinc-700 hover:bg-zinc-100',
  danger: 'border border-red-200 bg-white text-red-600 hover:bg-red-50'
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3 text-sm',
  lg: 'h-9 px-4 text-sm'
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leading?: ReactNode;
  trailing?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className = '', variant = 'secondary', size = 'md', leading, trailing, children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      className={`${buttonBase} ${buttonVariants[variant]} ${buttonSizes[size]} ${className}`}
      {...rest}
    >
      {leading}
      {children}
      {trailing}
    </button>
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={`h-8 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-[#5E6AD2] focus:outline-none focus:ring-2 focus:ring-[#5E6AD2]/30 ${className}`}
        {...rest}
      />
    );
  }
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className = '', ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={`w-full rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-[#5E6AD2] focus:outline-none focus:ring-2 focus:ring-[#5E6AD2]/30 ${className}`}
      {...rest}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = '', children, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={`h-8 rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-900 focus:border-[#5E6AD2] focus:outline-none focus:ring-2 focus:ring-[#5E6AD2]/30 ${className}`}
        {...rest}
      >
        {children}
      </select>
    );
  }
);

export function Card({
  className = '',
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-lg border border-zinc-200 bg-white ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Label({
  className = '',
  children,
  ...rest
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={`text-xs font-medium text-zinc-500 ${className}`}
      {...rest}
    >
      {children}
    </label>
  );
}

export function Badge({
  tone = 'default',
  children,
  title,
  className = ''
}: {
  tone?: 'default' | 'accent' | 'success' | 'warning' | 'muted';
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  const tones: Record<string, string> = {
    default: 'bg-zinc-100 text-zinc-700',
    accent: 'bg-[#5E6AD2]/10 text-[#5E6AD2]',
    success: 'bg-emerald-50 text-emerald-700',
    warning: 'bg-amber-50 text-amber-700',
    muted: 'bg-zinc-50 text-zinc-500'
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Divider({ className = '' }: { className?: string }) {
  return <div className={`h-px w-full bg-zinc-200 ${className}`} />;
}

export function Empty({
  title,
  description,
  action
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-zinc-200 bg-white px-6 py-16 text-center">
      <div className="h-10 w-10 rounded-lg bg-zinc-100" />
      <div>
        <p className="text-sm font-semibold text-zinc-900">{title}</p>
        {description ? (
          <p className="mt-1 text-xs text-zinc-500">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
