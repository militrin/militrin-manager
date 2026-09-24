import Image from 'next/image';
import { cx } from '@/components/militrin/utils';

type PublicPhoneMockupProps = {
  src: string;
  alt: string;
  width: number;
  height: number;
  priority?: boolean;
  className?: string;
};

export function PublicPhoneMockup({ src, alt, width, height, priority, className }: PublicPhoneMockupProps) {
  return (
    <div className={cx('relative mx-auto w-[200px] sm:w-[220px] lg:w-[300px]', className)}>
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-10 rounded-full bg-emerald-400/12 blur-3xl motion-reduce:opacity-0"
      />
      <div className="relative rounded-[2rem] border border-white/12 bg-black p-[6px] shadow-[0_24px_80px_rgba(0,0,0,0.55)]">
        <div className="overflow-hidden rounded-[1.55rem] bg-slate-950">
          <Image
            src={src}
            alt={alt}
            width={width}
            height={height}
            priority={priority}
            sizes="(max-width: 1023px) 220px, 300px"
            className="h-auto w-full"
          />
        </div>
      </div>
    </div>
  );
}
