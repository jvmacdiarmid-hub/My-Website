/* =============================================
   SHARED JS — Book Review Search
   ============================================= */

const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const statusEl = document.getElementById('status');
const searchResultsEl = document.getElementById('searchResults');
const detailViewEl = document.getElementById('detailView');
const apiKeyInput = document.getElementById('apiKeyInput');
const keyStatusEl = document.getElementById('keyStatus');

let cachedBooks = [];

// The category page sets this before loading app.js
const CATEGORY = window.BOOK_CATEGORY || '';

/* ===== API Key management ===== */

const API_KEY_STORAGE = 'claude_api_key';

function loadApiKey() {
    const saved = localStorage.getItem(API_KEY_STORAGE) || '';
    apiKeyInput.value = saved;
    updateKeyStatus();
}

function updateKeyStatus() {
    const key = apiKeyInput.value.trim();
    if (key && key.startsWith('sk-')) {
        keyStatusEl.textContent = 'Saved';
        keyStatusEl.className = 'key-status saved';
    } else {
        keyStatusEl.textContent = key ? 'Invalid format' : 'Not set';
        keyStatusEl.className = 'key-status missing';
    }
}

apiKeyInput.addEventListener('input', () => {
    const key = apiKeyInput.value.trim();
    if (key) {
        localStorage.setItem(API_KEY_STORAGE, key);
    } else {
        localStorage.removeItem(API_KEY_STORAGE);
    }
    updateKeyStatus();
});

loadApiKey();

function getApiKey() {
    return apiKeyInput.value.trim();
}

/* ===== Utilities ===== */

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchBooks();
});

function setStatus(msg, isError = false) {
    statusEl.innerHTML = msg;
    statusEl.className = 'status-message' + (isError ? ' error' : '');
}

function renderStars(rating) {
    if (!rating) return '';
    const full = Math.floor(rating);
    const half = rating - full >= 0.5 ? 1 : 0;
    const empty = 5 - full - half;
    return '\u2605'.repeat(full) + (half ? '\u00BD' : '') + '\u2606'.repeat(empty) + ' ' + rating.toFixed(1);
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/* ===== STEP 1: Search and show book list ===== */

async function searchBooks() {
    let query = searchInput.value.trim();
    if (!query) {
        setStatus('Please enter a book title.', true);
        return;
    }

    if (!getApiKey()) {
        setStatus('Please enter your Claude API key above first.', true);
        apiKeyInput.focus();
        return;
    }

    // Scope the search to the current category if set
    const scopedQuery = CATEGORY ? query + ' ' + CATEGORY : query;

    searchBtn.disabled = true;
    searchResultsEl.innerHTML = '';
    detailViewEl.innerHTML = '';
    detailViewEl.classList.remove('active');
    setStatus('<span class="spinner"></span> Searching for books...');

    try {
        const [olData, gbData] = await Promise.all([
            fetch(`https://openlibrary.org/search.json?title=${encodeURIComponent(scopedQuery)}&limit=8`)
                .then(r => r.json()).catch(() => null),
            fetch(`https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(query)}+subject:${encodeURIComponent(CATEGORY || 'nonfiction')}&maxResults=8`)
                .then(r => r.json()).catch(() => null)
        ]);

        const books = [];
        const seen = new Set();

        if (gbData && gbData.items) {
            for (const item of gbData.items) {
                const v = item.volumeInfo || {};
                const key = (v.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                if (seen.has(key)) continue;
                seen.add(key);
                books.push({
                    title: v.title || 'Unknown Title',
                    authors: v.authors || [],
                    cover: v.imageLinks ? (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail) : null,
                    description: v.description || '',
                    publishedDate: v.publishedDate || '',
                    categories: v.categories || [],
                    pageCount: v.pageCount || null,
                    rating: v.averageRating || null,
                    ratingsCount: v.ratingsCount || 0,
                    isbn: (v.industryIdentifiers || []).find(i => i.type === 'ISBN_13')?.identifier
                        || (v.industryIdentifiers || []).find(i => i.type === 'ISBN_10')?.identifier || '',
                    previewLink: v.previewLink || '',
                    olKey: '',
                    source: 'google'
                });
            }
        }

        if (olData && olData.docs) {
            for (const doc of olData.docs) {
                const key = (doc.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                if (seen.has(key)) continue;
                seen.add(key);
                books.push({
                    title: doc.title || 'Unknown Title',
                    authors: doc.author_name || [],
                    cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null,
                    description: '',
                    publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : '',
                    categories: doc.subject ? doc.subject.slice(0, 3) : [],
                    pageCount: doc.number_of_pages_median || null,
                    rating: doc.ratings_average || null,
                    ratingsCount: doc.ratings_count || 0,
                    isbn: (doc.isbn || [])[0] || '',
                    olKey: doc.key || '',
                    previewLink: '',
                    source: 'openlibrary'
                });
            }
        }

        if (books.length === 0) {
            setStatus('No books found. Try a different search term.', true);
            searchBtn.disabled = false;
            return;
        }

        cachedBooks = books;
        renderSearchResults(books);
        setStatus(`Select the book you're looking for:`);
    } catch (err) {
        console.error(err);
        setStatus('An error occurred while searching. Please try again.', true);
    }

    searchBtn.disabled = false;
}

function renderSearchResults(books) {
    searchResultsEl.innerHTML = '';
    books.forEach((book, idx) => {
        const item = document.createElement('div');
        item.className = 'book-list-item';
        item.setAttribute('role', 'button');
        item.setAttribute('tabindex', '0');
        item.onclick = () => selectBook(idx);
        item.onkeydown = (e) => { if (e.key === 'Enter') selectBook(idx); };

        const coverHtml = book.cover
            ? `<img src="${book.cover}" alt="" loading="lazy">`
            : `<div class="no-cover">No Cover</div>`;

        const metaTags = [];
        if (book.publishedDate) metaTags.push(book.publishedDate);
        if (book.authors.length) metaTags.push(book.authors[0]);
        if (book.rating) metaTags.push(`<span class="rating">${renderStars(book.rating)}</span>`);

        item.innerHTML = `
            <div class="book-list-inner">
                <div class="book-list-cover">${coverHtml}</div>
                <div class="book-list-info">
                    <div class="book-list-title">${escapeHtml(book.title)}</div>
                    <div class="book-list-author">${book.authors.length ? 'by ' + escapeHtml(book.authors.join(', ')) : ''}</div>
                    <div class="book-list-meta">${metaTags.map(t => `<span class="meta-tag">${t}</span>`).join('')}</div>
                </div>
                <div class="select-arrow">&#8250;</div>
            </div>
        `;
        searchResultsEl.appendChild(item);
    });
}

/* ===== STEP 2: Select book, fetch reviews, call Claude for Pros/Cons ===== */

async function selectBook(idx) {
    const book = cachedBooks[idx];
    if (!book) return;

    searchResultsEl.innerHTML = '';
    detailViewEl.classList.add('active');
    detailViewEl.innerHTML = '';
    setStatus('<span class="spinner"></span> Fetching reviews for "' + escapeHtml(book.title) + '"...');

    const reviews = await fetchReviews(book);
    book.reviews = reviews;

    setStatus('<span class="spinner"></span> Asking Claude to analyze reviews...');

    let pros = [];
    let cons = [];
    let aiError = false;

    try {
        const result = await callClaudeForProsCons(book);
        pros = result.pros;
        cons = result.cons;
    } catch (err) {
        console.error('Claude API error:', err);
        aiError = true;
    }

    setStatus('');
    renderDetailView(book, pros, cons, aiError);
}

function goBackToResults() {
    detailViewEl.classList.remove('active');
    detailViewEl.innerHTML = '';
    renderSearchResults(cachedBooks);
    setStatus(`Select the book you're looking for:`);
}

async function fetchReviews(book) {
    const reviews = [];

    if (!book.olKey && book.isbn) {
        try {
            const isbnRes = await fetch(`https://openlibrary.org/isbn/${book.isbn}.json`);
            const isbnData = await isbnRes.json();
            if (isbnData.works && isbnData.works.length > 0) {
                book.olKey = isbnData.works[0].key;
            }
        } catch (_) {}
    }

    if (!book.olKey) {
        try {
            const searchRes = await fetch(`https://openlibrary.org/search.json?title=${encodeURIComponent(book.title)}&limit=1`);
            const searchData = await searchRes.json();
            if (searchData.docs && searchData.docs.length > 0) {
                book.olKey = searchData.docs[0].key;
                if (!book.rating && searchData.docs[0].ratings_average) {
                    book.rating = searchData.docs[0].ratings_average;
                    book.ratingsCount = searchData.docs[0].ratings_count || 0;
                }
            }
        } catch (_) {}
    }

    if (book.olKey) {
        try {
            const workRes = await fetch(`https://openlibrary.org${book.olKey}.json`);
            const workData = await workRes.json();
            if (workData.description && !book.description) {
                book.description = typeof workData.description === 'string'
                    ? workData.description : workData.description.value || '';
            }
        } catch (_) {}

        try {
            const ratingsRes = await fetch(`https://openlibrary.org${book.olKey}/ratings.json`);
            const ratingsData = await ratingsRes.json();
            if (ratingsData.summary && ratingsData.summary.average && !book.rating) {
                book.rating = ratingsData.summary.average;
                book.ratingsCount = ratingsData.summary.count || 0;
            }
        } catch (_) {}
    }

    if (book.isbn) {
        try {
            const gbRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${book.isbn}&maxResults=1`);
            const gbData = await gbRes.json();
            if (gbData.items && gbData.items.length > 0) {
                const vol = gbData.items[0].volumeInfo || {};
                if (vol.averageRating && !book.rating) {
                    book.rating = vol.averageRating;
                    book.ratingsCount = vol.ratingsCount || 0;
                }
                if (vol.description && !book.description) {
                    book.description = vol.description;
                }
            }
        } catch (_) {}
    }

    if (book.olKey) {
        const workId = book.olKey.replace('/works/', '');
        try {
            const revRes = await fetch(`https://openlibrary.org/works/${workId}/ratings.json`);
            const revData = await revRes.json();
            if (revData.summary && revData.summary.average) {
                if (!book.rating) {
                    book.rating = revData.summary.average;
                    book.ratingsCount = revData.summary.count || 0;
                }
            }
            if (revData.counts) {
                book.ratingBreakdown = revData.counts;
            }
        } catch (_) {}

        try {
            const shelfRes = await fetch(`https://openlibrary.org/works/${workId}/bookshelves.json`);
            const shelfData = await shelfRes.json();
            if (shelfData.counts) {
                book.shelves = shelfData.counts;
            }
        } catch (_) {}
    }

    return reviews;
}

/* ===== Claude API call for Pros / Cons ===== */

async function callClaudeForProsCons(book) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('No API key');

    const reviewTexts = (book.reviews || [])
        .map((r, i) => `Review ${i + 1} (by ${r.author}${r.rating ? ', ' + r.rating + '/5' : ''}): ${r.text}`)
        .join('\n\n');

    const bookContext = [
        `Title: ${book.title}`,
        book.authors.length ? `Author(s): ${book.authors.join(', ')}` : '',
        book.publishedDate ? `Published: ${book.publishedDate}` : '',
        book.rating ? `Average rating: ${book.rating}/5 (${book.ratingsCount} ratings)` : '',
        book.ratingBreakdown ? `Rating breakdown: 1-star: ${book.ratingBreakdown['1'] || 0}, 2-star: ${book.ratingBreakdown['2'] || 0}, 3-star: ${book.ratingBreakdown['3'] || 0}, 4-star: ${book.ratingBreakdown['4'] || 0}, 5-star: ${book.ratingBreakdown['5'] || 0}` : '',
        book.shelves ? `Reader shelves: ${book.shelves.want_to_read || 0} want to read, ${book.shelves.currently_reading || 0} currently reading, ${book.shelves.already_read || 0} already read` : '',
        book.categories.length ? `Genres: ${book.categories.join(', ')}` : '',
        book.description ? `Description: ${book.description}` : '',
    ].filter(Boolean).join('\n');

    const userPrompt = `Here is information about a book, along with reader reviews I collected from Open Library and Google Books.

--- BOOK INFO ---
${bookContext}

--- READER REVIEWS ---
${reviewTexts || 'No individual text reviews were found from the APIs, but use the book info, description, rating data, and your knowledge of this book to produce the analysis.'}

Based on ALL available information (the reviews above, the book description, the rating data, and your general knowledge of this book and how it has been received), produce a Pros and Cons list.

- Pros: specific positive attributes readers commonly praise about this book
- Cons: specific criticisms or shortcomings readers commonly mention

Return ONLY valid JSON in this exact format, no other text:
{"pros": ["pro 1", "pro 2", ...], "cons": ["con 1", "con 2", ...]}

Provide 4-8 items per list. Each item should be a concise sentence (under 15 words). Be specific to THIS book, not generic.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 1024,
            messages: [
                { role: 'user', content: userPrompt }
            ]
        })
    });

    if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`API ${response.status}: ${errBody}`);
    }

    const data = await response.json();
    const text = data.content[0].text.trim();

    const jsonStr = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(jsonStr);

    return {
        pros: Array.isArray(parsed.pros) ? parsed.pros : [],
        cons: Array.isArray(parsed.cons) ? parsed.cons : []
    };
}

/* ===== Render detail view with Pros/Cons ===== */

function renderDetailView(book, pros, cons, aiError) {
    const coverHtml = book.cover
        ? `<img src="${book.cover}" alt="Cover of ${escapeHtml(book.title)}" loading="lazy">`
        : `<div class="no-cover">No Cover Available</div>`;

    const metaTags = [];
    if (book.publishedDate) metaTags.push(book.publishedDate);
    if (book.pageCount) metaTags.push(`${book.pageCount} pages`);
    if (book.categories.length) metaTags.push(book.categories[0]);
    if (book.rating) metaTags.push(`<span class="rating">${renderStars(book.rating)}</span>`);
    if (book.ratingsCount) metaTags.push(`${book.ratingsCount.toLocaleString()} rating(s)`);

    const descId = 'detail-desc';
    const descHtml = book.description
        ? `<p class="detail-description truncated" id="${descId}">${escapeHtml(book.description)}</p>
           <button class="toggle-desc" onclick="toggleDesc('${descId}', this)">Show more</button>`
        : '';

    const linksHtml = [];
    if (book.previewLink) {
        linksHtml.push(`<a href="${book.previewLink}" target="_blank" rel="noopener">Google Books</a>`);
    }
    if (book.olKey) {
        linksHtml.push(`<a href="https://openlibrary.org${book.olKey}" target="_blank" rel="noopener">Open Library</a>`);
    }
    if (book.isbn) {
        linksHtml.push(`<a href="https://www.goodreads.com/search?q=${book.isbn}" target="_blank" rel="noopener">Goodreads</a>`);
    }

    let prosConsHtml = '';
    if (aiError) {
        prosConsHtml = `
            <div class="reviews-section" style="margin-bottom:1.5rem;">
                <div class="section-header">Pros &amp; Cons</div>
                <div class="empty-list-msg">
                    Could not reach the Claude API. Please check your API key and try again.
                </div>
            </div>
        `;
    } else {
        const prosHtml = pros.length > 0
            ? `<ul class="pros-list">${pros.map(p => `<li><span>${escapeHtml(p)}</span></li>`).join('')}</ul>`
            : `<div class="empty-list-msg">No specific pros identified.</div>`;

        const consHtml = cons.length > 0
            ? `<ul class="cons-list">${cons.map(c => `<li><span>${escapeHtml(c)}</span></li>`).join('')}</ul>`
            : `<div class="empty-list-msg">No specific cons identified.</div>`;

        prosConsHtml = `
            <div class="pros-cons-container">
                <div class="pros-card">
                    <div class="section-header">Pros <span class="ai-badge">Claude AI</span></div>
                    ${prosHtml}
                </div>
                <div class="cons-card">
                    <div class="section-header">Cons <span class="ai-badge">Claude AI</span></div>
                    ${consHtml}
                </div>
            </div>
        `;
    }

    let rawReviewsHtml = '';
    if (book.reviews && book.reviews.length > 0) {
        const items = book.reviews.map(r => `
            <div class="review-item">
                <div class="review-author">${escapeHtml(r.author)} <span style="color:var(--text-muted);font-weight:400;font-size:0.78rem;">(${escapeHtml(r.source)})</span></div>
                ${r.rating ? `<div class="review-rating">${renderStars(r.rating)}</div>` : ''}
                <div class="review-text">${escapeHtml(r.text)}</div>
                ${r.date ? `<div class="review-date">${escapeHtml(r.date)}</div>` : ''}
            </div>
        `).join('');

        rawReviewsHtml = `
            <div class="reviews-section">
                <div class="section-header">Individual Reviews</div>
                ${items}
            </div>
        `;
    }

    detailViewEl.innerHTML = `
        <button class="back-btn" onclick="goBackToResults()">&larr; Back to results</button>

        <div class="detail-card">
            <div class="detail-card-inner">
                <div class="detail-cover">${coverHtml}</div>
                <div class="detail-info">
                    <div class="detail-title">${escapeHtml(book.title)}</div>
                    <div class="detail-author">${book.authors.length ? 'by ' + escapeHtml(book.authors.join(', ')) : 'Author unknown'}</div>
                    <div class="detail-meta">${metaTags.map(t => `<span class="meta-tag">${t}</span>`).join('')}</div>
                    ${descHtml}
                    <div class="external-links">${linksHtml.join('')}</div>
                </div>
            </div>
        </div>

        ${prosConsHtml}
        ${rawReviewsHtml}
    `;
}

function toggleDesc(id, btn) {
    const el = document.getElementById(id);
    if (el.classList.contains('truncated')) {
        el.classList.remove('truncated');
        btn.textContent = 'Show less';
    } else {
        el.classList.add('truncated');
        btn.textContent = 'Show more';
    }
}
