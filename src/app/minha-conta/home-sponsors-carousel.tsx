import Image from 'next/image';

export type HomeSponsor = {
  id: string;
  name: string;
  bannerUrl: string;
  linkUrl: string | null;
};

export function HomeSponsorsCarousel({
  sponsors,
}: {
  sponsors: HomeSponsor[];
  intervalSeconds?: number;
}) {
  if (sponsors.length === 0) return null;

  return (
    <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1 snap-x snap-mandatory [scrollbar-width:none] lg:mx-0 lg:flex lg:flex-wrap lg:overflow-visible lg:px-0 lg:pb-0 lg:snap-none [&::-webkit-scrollbar]:hidden">
      {sponsors.map((sponsor) => {
        const tile = (
          <div className="flex h-20 w-[min(46vw,180px)] shrink-0 snap-start items-center justify-center overflow-hidden rounded-2xl border border-slate-800/80 bg-slate-950/80 px-3 shadow-lg shadow-black/10 transition hover:border-emerald-500/30 lg:h-[5.5rem] lg:w-44">
            <div className="relative h-12 w-full">
              <Image
                src={sponsor.bannerUrl}
                alt={sponsor.name}
                fill
                unoptimized
                className="object-contain"
              />
            </div>
          </div>
        );

        if (!sponsor.linkUrl) return <div key={sponsor.id}>{tile}</div>;

        return (
          <a
            key={sponsor.id}
            href={sponsor.linkUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Visitar site de ${sponsor.name}`}
            className="block"
          >
            {tile}
          </a>
        );
      })}
    </div>
  );
}
