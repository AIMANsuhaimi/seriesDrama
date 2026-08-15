require('dotenv').config();
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');

// 🔑 Pull TMDB API Key from environment variables (Do NOT hardcode it when pushing to GitHub!)
const TMDB_API_KEY = process.env.TMDB_API_KEY; 

// 1. Manifest
const manifest = {
  id: 'org.hardcoded.scraper',
  version: '1.0.0',
  name: 'Custom Scraper Addon',
  description: 'All-in-one Catalog and Stream Scraper',
  resources: ['catalog', 'stream'], // Both Catalog AND Stream are handled here
  types: ['series', 'movie'],
  idPrefixes: ['tt'],
  catalogs: [
    { type: 'series', id: 'anime_series', name: 'Anime Series', extra: [{ name: 'skip', isRequired: false }] },
    { type: 'movie', id: 'anime_movies', name: 'Anime Movies', extra: [{ name: 'skip', isRequired: false }] },
    { type: 'series', id: 'kdrama_series', name: 'K-Drama Series', extra: [{ name: 'skip', isRequired: false }] },
    { type: 'series', id: 'marvel_series', name: 'Marvel Series', extra: [{ name: 'skip', isRequired: false }] }
  ]
};

const builder = new addonBuilder(manifest);

// 2. Catalog Handler (Builds the UI)
builder.defineCatalogHandler(async (args) => {
  const { type, id, extra } = args;
  
  const skip = extra && extra.skip ? parseInt(extra.skip) : 0;
  const page = Math.floor(skip / 20) + 1; 
  
  let endpoint = '';

  if (type === 'series' && id === 'anime_series') {
    endpoint = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&with_genres=16&with_original_language=ja&sort_by=popularity.desc&page=${page}`;
  } else if (type === 'movie' && id === 'anime_movies') {
    endpoint = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_genres=16&with_original_language=ja&sort_by=popularity.desc&page=${page}`;
  } else if (type === 'series' && id === 'kdrama_series') {
    endpoint = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&with_origin_country=KR&sort_by=popularity.desc&page=${page}`;
  } else if (type === 'series' && id === 'marvel_series') {
    endpoint = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&with_companies=420&sort_by=popularity.desc&page=${page}`;
  } else {
    return { metas: [] };
  }

  try {
    const response = await axios.get(endpoint);

    const metas = await Promise.all(
      response.data.results.map(async (item) => {
        let imdbId = `tt${item.id}`;

        return {
          id: imdbId,
          type: type,
          name: item.name || item.title,
          poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
          description: item.overview
        };
      })
    );
    return { metas };
  } catch (err) {
    return { metas: [] };
  }
});

// 3. Dynamic Stream Scraper (The Hardcoded Solution)
builder.defineStreamHandler(async (args) => {
  const { type, id } = args;
  let streams = [];

  try {
    // 🎬 ROUTE A: It is a MOVIE
    if (type === 'movie') {
      const ytsRes = await axios.get(`https://yts.mx/api/v2/list_movies.json?query_term=${id}`);
      const movie = ytsRes.data?.data?.movies?.[0];
      
      if (movie && movie.torrents) {
        movie.torrents.forEach(t => {
          streams.push({
            name: `YTS [${t.quality}]`,
            title: `${movie.title}\n💾 ${t.size} | 👥 ${t.seeds}`,
            infoHash: t.hash.toLowerCase()
          });
        });
      }
    } 
    // 📺 ROUTE B: It is a TV SERIES / ANIME EPISODE
    else if (type === 'series' && id.includes(':')) {
      const [imdbId, season, episode] = id.split(':');
      let cleanImdbId = imdbId.replace('tt', '');
      let realImdbId = imdbId;
      let seriesName = '';

      // Ensure we have a real IMDB ID for Torrentio, and get the Title for Nyaa
      try {
        const tmdbFindId = await axios.get(`https://api.themoviedb.org/3/tv/${cleanImdbId}/external_ids?api_key=${TMDB_API_KEY}`);
        if (tmdbFindId.data.imdb_id) {
          realImdbId = tmdbFindId.data.imdb_id;
          cleanImdbId = realImdbId.replace('tt', '');
        }
      } catch (e) {}
        
      try {
        // Fetch series name from TMDB to use for Nyaa search
        const tmdbFindTitle = await axios.get(`https://api.themoviedb.org/3/find/${realImdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`);
        if (tmdbFindTitle.data.tv_results && tmdbFindTitle.data.tv_results.length > 0) {
          seriesName = tmdbFindTitle.data.tv_results[0].name;
        }
      } catch (e) {}
      
      // Fire EZTV, Torrentio, and Nyaa concurrently to make it fast!
      const eztvPromise = axios.get(`https://eztvx.to/api/get-torrents?imdb_id=${cleanImdbId}`).catch(() => null);
      const torrentioPromise = axios.get(`https://torrentio.strem.fun/stream/series/${realImdbId}:${season}:${episode}.json`).catch(() => null);
      
      let nyaaPromise = Promise.resolve(null);
      if (seriesName) {
        // Nyaa typically uses padded episode numbers for anime (e.g. "Initial D 01")
        const epPad = episode.padStart(2, '0');
        const query = encodeURIComponent(`${seriesName} ${epPad}`);
        // Search Nyaa's Anime - English translated category (c=1_2)
        nyaaPromise = axios.get(`https://nyaa.si/?page=rss&q=${query}&c=1_2&f=0`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/xml, text/xml, */*'
          }
        }).catch(() => null);
      }
      
      const [eztvRes, torrentioRes, nyaaRes] = await Promise.all([eztvPromise, torrentioPromise, nyaaPromise]);
      
      if (!seriesName) {
        streams.push({ name: 'DEBUG', title: 'TMDB failed to find seriesName', infoHash: '1111111111111111111111111111111111111111' });
      } else if (!nyaaRes || !nyaaRes.data) {
        streams.push({ name: 'DEBUG', title: 'Nyaa blocked the request (No Data)', infoHash: '2222222222222222222222222222222222222222' });
      }
      
      // Process EZTV (Western shows)
      if (eztvRes && eztvRes.data && eztvRes.data.torrents) {
        const exactEpisodes = eztvRes.data.torrents.filter(
          (t) => parseInt(t.season) === parseInt(season) && parseInt(t.episode) === parseInt(episode)
        );
        exactEpisodes.forEach(t => {
          streams.push({
            name: 'EZTV',
            title: t.title,
            infoHash: t.hash.toLowerCase()
          });
        });
      }

      // Process Nyaa (Anime)
      if (nyaaRes && nyaaRes.data) {
        const xmlData = nyaaRes.data;
        const items = [...xmlData.matchAll(/<item>([\s\S]*?)<\/item>/g)];
        items.forEach(item => {
          let title = "";
          const cdataMatch = item[1].match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/);
          if (cdataMatch) title = cdataMatch[1];
          else {
            const titleMatch = item[1].match(/<title>(.*?)<\/title>/);
            if (titleMatch) title = titleMatch[1];
          }
          
          const infoHash = item[1].match(/<nyaa:infoHash>(.*?)<\/nyaa:infoHash>/)?.[1];
          const size = item[1].match(/<nyaa:size>(.*?)<\/nyaa:size>/)?.[1] || 'Unknown';
          const seeders = item[1].match(/<nyaa:seeders>(.*?)<\/nyaa:seeders>/)?.[1] || '0';
          
          if (infoHash) {
            streams.push({
              name: 'Nyaa.si',
              title: `${title}\n💾 ${size} | 👥 ${seeders}`,
              infoHash: infoHash.toLowerCase()
            });
          }
        });
        
        if (items.length === 0) {
           streams.push({ name: 'DEBUG', title: 'Nyaa returned XML but regex found 0 items', infoHash: '3333333333333333333333333333333333333333' });
        }
      }

      // Process Torrentio (Fallback, likely blocked on Render)
      if (streams.length === 0 && torrentioRes && torrentioRes.data && torrentioRes.data.streams) {
        torrentioRes.data.streams.slice(0, 10).forEach(t => {
          if (t.infoHash) {
            streams.push({
              name: 'Torrentio Fallback',
              title: t.title,
              infoHash: t.infoHash.toLowerCase()
            });
          }
        });
      }
    }
  } catch (e) {
    console.error('Scraper Error:', e.message);
  }

  return { streams };
});

// 4. Serverless Router for Vercel
const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.url === '/' || req.url === '') req.url = '/manifest.json';

  router(req, res, () => {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not Found' }));
  });
};
