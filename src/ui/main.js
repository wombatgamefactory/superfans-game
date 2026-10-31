// Placeholder entry point so the page loads. The real UI replaces this.
import { CONFIG } from './config.js';

const app = document.getElementById('app');
app.textContent = 'Superfans - coming soon';
app.dataset.version = CONFIG.VERSION;
