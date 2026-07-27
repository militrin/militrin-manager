import Image from 'next/image';
import { cx } from './utils';

type MilitrinAvatarProps = {
  src?: string | null;
  alt: string;
  initials: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
};

const sizeClass = {
  sm: 'h-10 w-10 text-sm',
  md: 'h-14 w-14 text-lg',
  lg: 'h-20 w-20 text-2xl',
} as const;

export function MilitrinAvatar({ src, alt, initials, size = 'md', className }: MilitrinAvatarProps) {
  return (
    <div className={cx('relative overflow-hidden rounded-[1.25rem] border border-white/20 bg-slate-900', sizeClass[size], className)}>
      {src ? (
        <Image src={src} alt={alt} fill unoptimized className="object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center font-semibold text-slate-300">{initials || 'MP'}</div>
      )}
    </div>
  );
}
