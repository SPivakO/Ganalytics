// State
let state = {
  accounts: [],
  campaigns: [],
  reportData: [],
  sortColumn: 'cost',
  sortDirection: 'desc',
  showAccount: false,
  showCampaign: true,
  dateRange: { start: null, end: null },  // global period, drives every tab
  dashboard: {
    google: null,
    applovin: null,
    mintegral: null
  }
};

// Per-picker "Show all" flags (default: only ENABLED entities are listed)
let pickerFlags = {
  reportCampaigns: false,
  reportAdgroups: false,
  uploadCampaigns: false,
  editCampaigns: false,
  editAdgroups: false,
  srcCampaigns: false,
  srcAdgroups: false,
  dstCampaigns: false,
  dstAdgroups: false
};

// Reports DOM
const accountsContainer = document.getElementById('accounts-container');
const campaignsContainer = document.getElementById('campaigns-container');
const reportAdgroupsGroup = document.getElementById('report-adgroups-group');
const reportAdgroupsContainer = document.getElementById('report-adgroups-container');
const loadBtn = document.getElementById('load-btn');
const downloadBtn = document.getElementById('download-btn');
const resultsPanel = document.getElementById('results-panel');
const resultsBody = document.getElementById('results-body');
const resultsThead = document.getElementById('results-thead');
const groupByAccountCheckbox = document.getElementById('group-by-account');
const groupByCampaignCheckbox = document.getElementById('group-by-campaign');

// Dashboard DOM
const dashPlatformSelect = document.getElementById('dash-platform');
const dashAppSelect = document.getElementById('dash-app');
const dashAccountsToggle = document.getElementById('dash-accounts-toggle');
const dashAccountsMenu = document.getElementById('dash-accounts-menu');
const dashLoadBtn = document.getElementById('dash-load-btn');
const chartGoogleEl = document.getElementById('chart-google');
const chartApplovinEl = document.getElementById('chart-applovin');
const chartMintegralEl = document.getElementById('chart-mintegral');
const listGoogleEl = document.getElementById('list-google');
const listApplovinEl = document.getElementById('list-applovin');
const listMintegralEl = document.getElementById('list-mintegral');
const chartCvrEl = document.getElementById('chart-cvr');

// Dashboard accounts state
let dashAccountsLoaded = false;
let globalDatePicker = null;

// Upload DOM
const uploadAccountsContainer = document.getElementById('upload-accounts-container');
const uploadCampaignsContainer = document.getElementById('upload-campaigns-container');
const adgroupNameInput = document.getElementById('adgroup-name');
const youtubeUrlsInput = document.getElementById('youtube-urls');
const headlinesInput = document.getElementById('headlines-input');
const descriptionsInput = document.getElementById('descriptions-input');
const uploadBtn = document.getElementById('upload-btn');
const uploadResults = document.getElementById('upload-results');
const uploadLog = document.getElementById('upload-log');

// Edit Ad Group DOM
const editAccountsContainer = document.getElementById('edit-accounts-container');
const editCampaignsContainer = document.getElementById('edit-campaigns-container');
const editAdgroupsContainer = document.getElementById('edit-adgroups-container');
const editCreativesPanel = document.getElementById('edit-creatives-panel');
const editCreativesBody = document.getElementById('edit-creatives-body');
const editAddPanel = document.getElementById('edit-add-panel');
const editAddUrls = document.getElementById('edit-add-urls');
const editApplyBtn = document.getElementById('edit-apply-btn');
const editResults = document.getElementById('edit-results');
const editLog = document.getElementById('edit-log');

// Migrate 2nd Touch DOM (per-pane containers keyed by 'src'/'dst')
const migratePanes = {
  src: {
    accounts: document.getElementById('src-accounts-container'),
    campaigns: document.getElementById('src-campaigns-container'),
    adgroups: document.getElementById('src-adgroups-container'),
    panel: document.getElementById('src-creatives-panel'),
    body: document.getElementById('src-creatives-body'),
    count: document.getElementById('src-creatives-count'),
  },
  dst: {
    accounts: document.getElementById('dst-accounts-container'),
    campaigns: document.getElementById('dst-campaigns-container'),
    adgroups: document.getElementById('dst-adgroups-container'),
    panel: document.getElementById('dst-creatives-panel'),
    body: document.getElementById('dst-creatives-body'),
    count: document.getElementById('dst-creatives-count'),
  }
};
const migrateFooter = document.getElementById('migrate-footer');
const migrateSummary = document.getElementById('migrate-summary');
const migrateApplyBtn = document.getElementById('migrate-apply-btn');
const migrateResults = document.getElementById('migrate-results');
const migrateLog = document.getElementById('migrate-log');

// Common Elements
const loadingOverlay = document.getElementById('loading-overlay');
const errorMessage = document.getElementById('error-message');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initializeGlobalDates();
  initializeTabs();
  loadAccounts();
  setupEventListeners();
  initializeDashboardDefaults();
});

function formatDate(d){
  // Build YYYY-MM-DD from local parts. Using toISOString() here shifts the date
  // to UTC and rolls back a day for timezones east of UTC.
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

// ==================== GLOBAL DATE RANGE ====================
function initializeGlobalDates(){
  const input = document.getElementById('global-date-range');
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 6);  // last 7 days including today
  state.dateRange = { start: formatDate(start), end: formatDate(end) };
  if (input && window.flatpickr) {
    globalDatePicker = flatpickr(input, {
      mode: 'range',
      dateFormat: 'Y-m-d',
      defaultDate: [start, end],
      locale: { rangeSeparator: ' — ' },
      onChange: (dates) => {
        if (dates.length === 2) {
          state.dateRange = { start: formatDate(dates[0]), end: formatDate(dates[1]) };
          onGlobalDatesChanged();
        }
      }
    });
  } else if (input) {
    input.value = `${state.dateRange.start} — ${state.dateRange.end}`;
  }
}

function onGlobalDatesChanged(){
  // Refresh already-populated views that depend on the period
  if (getSelectedAccountIds().length) onAccountChange();
  if (_editContext.ad_group_id) loadEditCreatives();
  for (const pane of ['src','dst']) {
    if (_migrate[pane].order.length) {
      _migrate[pane].byGroup = {};
      onMigrateAdgroupsChanged(pane, _migrate[pane].order.slice());
    }
  }
}

function initializeTabs(){
  document.querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const tabId = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
      document.getElementById(`${tabId}-tab`).classList.add('active');
    });
  });
}

function setupEventListeners(){
  document.querySelectorAll('input[name="adgroup_type"]').forEach(r=>{
    r.addEventListener('change', e=>{
      const isTest = e.target.value === 'test';
      reportAdgroupsGroup.classList.toggle('hidden', !isTest);
      if (isTest) loadReportAdgroups();
    });
  });
  loadBtn.addEventListener('click', loadReport);
  downloadBtn.addEventListener('click', downloadCSV);
  uploadBtn.addEventListener('click', createTestAdGroups);
  if (dashLoadBtn) dashLoadBtn.addEventListener('click', loadDashboard);
  if (editApplyBtn) editApplyBtn.addEventListener('click', applyReplace);
  if (migrateApplyBtn) migrateApplyBtn.addEventListener('click', applyMigration);
}

// ==================== PICKER COMPONENT ====================
// createPicker(container, opts) renders a searchable list with a sticky header.
// opts: items [{id,name,status?,hint?}], multi, searchable, showAllToggle, showAll,
//       selectAllDefault, selected [], emptyText, onChange(ids), onShowAllChange(bool)
function createPicker(container, opts){
  const o = Object.assign({
    items: [], multi: true, searchable: true,
    showAllToggle: false, showAll: false,
    selectAllDefault: false, selected: [],
    emptyText: 'No items', onChange: null, onShowAllChange: null
  }, opts);

  const selected = new Set((o.selected || []).map(String));
  if (o.selectAllDefault && selected.size === 0) o.items.forEach(i => selected.add(String(i.id)));
  const radioName = 'pk_' + container.id;
  let filter = '';

  container.classList.add('picker');
  container.innerHTML = `
    <div class="picker-head">
      ${o.searchable ? '<input type="search" class="picker-search" placeholder="Search...">' : ''}
      <div class="picker-head-row">
        ${o.multi ? '<div class="picker-actions"><button type="button" data-act="all">All</button><button type="button" data-act="none">None</button></div>' : '<div class="picker-actions"></div>'}
        ${o.showAllToggle ? `<label class="picker-showall"><input type="checkbox" ${o.showAll ? 'checked' : ''}> Show all</label>` : ''}
        <span class="picker-count"></span>
      </div>
    </div>
    <div class="picker-list"></div>`;

  const listEl = container.querySelector('.picker-list');
  const countEl = container.querySelector('.picker-count');
  const searchEl = container.querySelector('.picker-search');

  function updateCount(){
    countEl.textContent = o.multi ? `${selected.size} / ${o.items.length}` : `${o.items.length}`;
  }

  function renderList(){
    const f = filter.trim().toLowerCase();
    const shown = o.items.filter(i => !f || (i.name || '').toLowerCase().includes(f) || (i.hint || '').toLowerCase().includes(f));
    if (!shown.length) {
      listEl.innerHTML = `<div class="placeholder">${escapeHtml(o.items.length ? 'No matches' : o.emptyText)}</div>`;
      updateCount();
      return;
    }
    listEl.innerHTML = shown.map(i => {
      const id = String(i.id);
      const paused = i.status && i.status !== 'ENABLED';
      const type = o.multi ? 'checkbox' : 'radio';
      const nameAttr = o.multi ? '' : `name="${radioName}"`;
      return `<label class="picker-item${paused ? ' is-paused' : ''}">
        <input type="${type}" ${nameAttr} value="${escapeHtml(id)}" ${selected.has(id) ? 'checked' : ''}>
        <span class="picker-item-name" title="${escapeHtml(i.name || '')}">${escapeHtml(i.name || '')}</span>
        ${i.hint ? `<span class="picker-item-hint" title="${escapeHtml(i.hint)}">${escapeHtml(i.hint)}</span>` : ''}
        ${paused ? `<span class="picker-item-status">${escapeHtml(i.status)}</span>` : ''}
      </label>`;
    }).join('');
    updateCount();
  }

  function emit(){ if (o.onChange) o.onChange(Array.from(selected)); }

  listEl.addEventListener('change', (e) => {
    const input = e.target;
    if (!input || input.value === undefined) return;
    if (o.multi) {
      if (input.checked) selected.add(input.value); else selected.delete(input.value);
    } else {
      selected.clear();
      if (input.checked) selected.add(input.value);
    }
    updateCount();
    emit();
  });

  if (searchEl) {
    searchEl.addEventListener('input', () => { filter = searchEl.value; renderList(); });
    // Keep picker scroll from stealing the search focus
    searchEl.addEventListener('click', (e) => e.stopPropagation());
  }

  container.querySelectorAll('.picker-actions button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.act === 'all') o.items.forEach(i => selected.add(String(i.id)));
      else selected.clear();
      renderList();
      emit();
    });
  });

  const showAllCb = container.querySelector('.picker-showall input');
  if (showAllCb) {
    showAllCb.addEventListener('change', () => {
      if (o.onShowAllChange) o.onShowAllChange(showAllCb.checked);
    });
  }

  renderList();

  const api = {
    getSelected: () => Array.from(selected),
    clear: () => { selected.clear(); renderList(); }
  };
  container._picker = api;
  return api;
}

function pickerSelected(container){
  return (container && container._picker) ? container._picker.getSelected() : [];
}

function setPickerPlaceholder(container, text){
  if (!container) return;
  delete container._picker;
  container.innerHTML = `<div class="placeholder">${escapeHtml(text)}</div>`;
}

function setPickerLoading(container, text){
  if (!container) return;
  delete container._picker;
  container.innerHTML = `<div class="loading">${escapeHtml(text || 'Loading...')}</div>`;
}

// ==================== ACCOUNTS (shared) ====================
async function loadAccounts(){
  try{
    const resp = await fetch('/api/accounts');
    const text = await resp.text();
    if(!resp.ok){
      let msg = `HTTP ${resp.status}`;
      try{ msg = JSON.parse(text).detail || msg; }catch(_){ msg = text || msg; }
      throw new Error(msg);
    }
    const data = JSON.parse(text);
    state.accounts = data.accounts;
    const items = state.accounts.map(a => ({ id: a.id, name: a.name }));
    createPicker(accountsContainer, { items, onChange: () => onAccountChange() });
    createPicker(uploadAccountsContainer, { items, onChange: () => onUploadAccountChange() });
    createPicker(editAccountsContainer, { items, onChange: () => onEditAccountChange() });
    createPicker(migratePanes.src.accounts, { items, onChange: () => onMigrateAccountChange('src') });
    createPicker(migratePanes.dst.accounts, { items, onChange: () => onMigrateAccountChange('dst') });
  }catch(e){showError('Failed to load accounts: '+e.message);}
}

// ==================== REPORTS TAB ====================
function getSelectedAccountIds(){ return pickerSelected(accountsContainer); }
function getSelectedCampaignIds(){ return pickerSelected(campaignsContainer); }
function isTestSelected(){
  const r = document.querySelector('input[name="adgroup_type"]:checked');
  return r && r.value === 'test';
}

async function onAccountChange(){
  const selectedIds = getSelectedAccountIds();
  if(!selectedIds.length){
    setPickerPlaceholder(campaignsContainer, 'Select accounts first');
    setPickerPlaceholder(reportAdgroupsContainer, 'Select campaigns first');
    state.campaigns = [];
    return;
  }
  const { start: sd, end: ed } = state.dateRange;
  setPickerLoading(campaignsContainer, 'Loading campaigns with spend...');
  try{
    const resp = await fetch(`/api/campaigns?account_ids=${selectedIds.join(',')}&start_date=${sd}&end_date=${ed}&show_all=${pickerFlags.reportCampaigns}`);
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.detail||'Failed to load campaigns');
    state.campaigns = data.campaigns;
    createPicker(campaignsContainer, {
      items: state.campaigns.map(c => ({ id: c.id, name: c.name, status: c.status })),
      selectAllDefault: true,
      showAllToggle: true,
      showAll: pickerFlags.reportCampaigns,
      emptyText: 'No campaigns found',
      onChange: () => { if (isTestSelected()) loadReportAdgroups(); },
      onShowAllChange: (v) => { pickerFlags.reportCampaigns = v; onAccountChange(); }
    });
    if (isTestSelected()) loadReportAdgroups();
  }catch(e){
    setPickerPlaceholder(campaignsContainer, `Error: ${e.message}`);
  }
}

async function loadReportAdgroups(){
  const accountIds = getSelectedAccountIds();
  const campaignIds = getSelectedCampaignIds();
  if(!campaignIds.length){
    setPickerPlaceholder(reportAdgroupsContainer, 'Select campaigns first');
    return;
  }
  setPickerLoading(reportAdgroupsContainer, 'Loading ad groups...');
  try{
    const resp = await fetch(`/api/adgroups?account_ids=${accountIds.join(',')}&campaign_ids=${campaignIds.join(',')}&show_all=${pickerFlags.reportAdgroups}`);
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.detail||'Failed to load ad groups');
    createPicker(reportAdgroupsContainer, {
      items: data.adgroups.map(g => ({
        id: g.id, name: g.ad_group_name, status: g.status
      })),
      showAllToggle: true,
      showAll: pickerFlags.reportAdgroups,
      emptyText: 'No ad groups found',
      onShowAllChange: (v) => { pickerFlags.reportAdgroups = v; loadReportAdgroups(); }
    });
  }catch(e){
    setPickerPlaceholder(reportAdgroupsContainer, `Error: ${e.message}`);
  }
}

async function loadReport(){
  const accountIds = getSelectedAccountIds();
  const campaignIds = getSelectedCampaignIds();
  const adgroupType = document.querySelector('input[name="adgroup_type"]:checked').value;
  const adGroupIds = adgroupType === 'test' ? pickerSelected(reportAdgroupsContainer) : [];
  const { start: sd, end: ed } = state.dateRange;
  const groupByAccount = groupByAccountCheckbox.checked;
  const groupByCampaign = groupByCampaignCheckbox.checked;
  if(!accountIds.length){showError('Please select at least one account'); return;}
  if(!sd||!ed){showError('Please select date range'); return;}
  if(adgroupType==='test' && !adGroupIds.length){showError('Please select at least one test ad group'); return;}
  hideError(); showLoading();
  try{
    const resp=await fetch('/api/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      account_ids:accountIds,campaign_ids:campaignIds,adgroup_type:adgroupType,
      ad_group_ids:adGroupIds.length?adGroupIds:null,
      start_date:sd,end_date:ed,group_by_account:groupByAccount,group_by_campaign:groupByCampaign
    })});
    const data=await resp.json();
    if(!resp.ok) throw new Error(data.detail||'Failed to load report');
    state.reportData=data.data;
    state.showAccount=groupByAccount;
    state.showCampaign=groupByCampaign;
    renderResults(data);
  }catch(e){showError('Failed to load report: '+e.message);}
  finally{hideLoading();}
}

function renderResults(data){
  document.getElementById('results-count').textContent=`${data.count} creatives`;
  document.getElementById('total-cost').textContent=formatCurrency(data.totals.cost);
  document.getElementById('total-impressions').textContent=formatNumber(data.totals.impressions);
  document.getElementById('total-installs').textContent=formatNumber(data.totals.installs);
  resultsPanel.classList.remove('hidden');
  renderTableHeader();
  sortAndRenderTable();
  updateSortIndicators();
}
function renderTableHeader(){
  let cols = '<th class="sortable" data-sort="asset_name">Asset Name</th>';
  if(state.showAccount) cols += '<th class="sortable" data-sort="account">Account</th>';
  if(state.showCampaign) cols += '<th class="sortable" data-sort="campaign">Campaign</th>';
  cols += `
    <th class="sortable numeric" data-sort="cost">Cost</th>
    <th class="sortable numeric" data-sort="impressions">Impressions</th>
    <th class="sortable numeric" data-sort="installs">Installs</th>
  `;
  resultsThead.innerHTML = `<tr>${cols}</tr>`;
  // Re-attach sort listeners
  resultsThead.querySelectorAll('th.sortable').forEach(th=>{
    th.addEventListener('click',()=>{
      const col = th.dataset.sort;
      if(state.sortColumn===col){
        state.sortDirection = state.sortDirection==='asc'?'desc':'asc';
      } else {
        state.sortColumn = col;
        state.sortDirection = (col==='asset_name' || col==='campaign' || col==='account') ? 'asc' : 'desc';
      }
      sortAndRenderTable();
      updateSortIndicators();
    });
  });
}
function sortAndRenderTable(){
  const sorted=[...state.reportData].sort((a,b)=>{
    let av=a[state.sortColumn], bv=b[state.sortColumn];
    if(av===undefined || av===null) av='';
    if(bv===undefined || bv===null) bv='';
    if(typeof av==='string' && typeof bv==='string'){
      av=av.toLowerCase();
      bv=bv.toLowerCase();
    }
    if(av===bv) return 0;
    const res = av > bv ? 1 : -1;
    return state.sortDirection==='asc' ? res : -res;
  });
  resultsBody.innerHTML=sorted.map(r=>{
    let row = `<td class="asset-name" title="${escapeHtml(r.asset_name)}">${escapeHtml(r.asset_name)}</td>`;
    if(state.showAccount) row += `<td class="account-name" title="${escapeHtml(r.account||'')}">${escapeHtml(r.account||'')}</td>`;
    if(state.showCampaign) row += `<td class="campaign-name" title="${escapeHtml(r.campaign||'')}">${escapeHtml(r.campaign||'')}</td>`;
    row += `
      <td class="numeric cost-cell">${formatCurrency(r.cost)}</td>
      <td class="numeric impressions-cell">${formatNumber(r.impressions)}</td>
      <td class="numeric installs-cell">${formatNumber(r.installs)}</td>
    `;
    return `<tr>${row}</tr>`;
  }).join('');
}
function updateSortIndicators(){
  resultsThead.querySelectorAll('th.sortable').forEach(th=>{
    th.classList.remove('sorted-asc','sorted-desc');
    if(th.dataset.sort===state.sortColumn){
      th.classList.add(state.sortDirection==='asc'?'sorted-asc':'sorted-desc');
    }
  });
}
function downloadCSV(){
  if(!state.reportData.length) return;
  let headers=['asset_name'];
  if(state.showAccount) headers.push('account');
  if(state.showCampaign) headers.push('campaign');
  headers.push('cost','impressions','installs');
  const csv=[headers.join(','), ...state.reportData.map(r=>headers.map(h=>{
    let v=r[h]||''; if(typeof v==='string') v=`"${v.replace(/"/g,'""')}"`; return v;
  }).join(','))].join('\n');
  const blob=new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a'); link.href=url; link.download=`youtube_assets_${state.dateRange.start}_${state.dateRange.end}.csv`; link.click(); URL.revokeObjectURL(url);
}

// ==================== UPLOAD TAB ====================
function getUploadSelectedAccountIds(){ return pickerSelected(uploadAccountsContainer); }
function getUploadSelectedCampaignIds(){ return pickerSelected(uploadCampaignsContainer); }

async function onUploadAccountChange() {
  const selectedIds = getUploadSelectedAccountIds();
  if (!selectedIds.length) {
    setPickerPlaceholder(uploadCampaignsContainer, 'Select accounts first');
    return;
  }
  setPickerLoading(uploadCampaignsContainer, 'Loading campaigns...');
  try {
    const response = await fetch(`/api/all_campaigns?account_ids=${selectedIds.join(',')}&show_all=${pickerFlags.uploadCampaigns}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Failed to load campaigns');
    createPicker(uploadCampaignsContainer, {
      items: data.campaigns.map(c => ({ id: c.id, name: c.name, status: c.status })),
      showAllToggle: true,
      showAll: pickerFlags.uploadCampaigns,
      emptyText: 'No campaigns found',
      onShowAllChange: (v) => { pickerFlags.uploadCampaigns = v; onUploadAccountChange(); }
    });
  } catch (e) {
    setPickerPlaceholder(uploadCampaignsContainer, `Error: ${e.message}`);
  }
}

async function createTestAdGroups() {
  const campaignIds = getUploadSelectedCampaignIds();
  const adgroupName = adgroupNameInput.value.trim();
  const youtubeUrls = youtubeUrlsInput.value.trim().split('\n').filter(url => url.trim());
  const headlines = headlinesInput.value.trim().split('\n').filter(h => h.trim()).slice(0, 5);
  const descriptions = descriptionsInput.value.trim().split('\n').filter(d => d.trim()).slice(0, 5);

  if (!campaignIds.length) return showError('Please select at least one campaign');
  if (!adgroupName) return showError('Please enter ad group name');
  if (!youtubeUrls.length) return showError('Please enter at least one YouTube URL');
  if (!headlines.length) return showError('Please enter at least one headline');
  if (!descriptions.length) return showError('Please enter at least one description');

  hideError(); showLoading();
  try {
    const resp = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaign_ids: campaignIds,
        adgroup_name: adgroupName,
        youtube_urls: youtubeUrls,
        headlines: headlines,
        descriptions: descriptions
      })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || 'Failed to create ad groups');
    renderUploadResults(data.results);
  } catch (e) {
    showError('Failed to create ad groups: ' + e.message);
  } finally {
    hideLoading();
  }
}

function renderUploadResults(results) {
  uploadResults.classList.remove('hidden');
  uploadLog.innerHTML = results.map(r => {
    const logsHtml = r.logs ? `<div class="upload-logs">${r.logs.map(l => `<div class="log-line">${escapeHtml(l)}</div>`).join('')}</div>` : '';
    if (r.success) {
      return `
        <div class="upload-log-item success">
          <div class="log-header">
            ✓ Created ad group "<strong>${escapeHtml(r.adgroup_name)}</strong>"
            with ${r.videos_count} videos (${r.assets_created || 0} new assets)
            <span class="campaign-name">(Campaign ID: ${r.campaign_id})</span>
          </div>
          ${logsHtml}
        </div>
      `;
    } else {
      return `
        <div class="upload-log-item error">
          <div class="log-header">
            ✗ Failed for campaign ${r.campaign_id}: ${escapeHtml(r.error)}
          </div>
          ${logsHtml}
        </div>
      `;
    }
  }).join('');
}

// ==================== HELPERS ====================
function formatCurrency(v){return '$'+v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
function formatNumber(v){return v.toLocaleString('en-US');}
function escapeHtml(t){const d=document.createElement('div'); d.textContent=t; return d.innerHTML;}
function showLoading(){loadingOverlay.classList.remove('hidden'); loadBtn.disabled=true; uploadBtn.disabled=true;}
function hideLoading(){loadingOverlay.classList.add('hidden'); loadBtn.disabled=false; uploadBtn.disabled=false;}
function showError(m){errorMessage.textContent=m; errorMessage.classList.remove('hidden');}
function hideError(){errorMessage.classList.add('hidden');}

function creativesDateParams(){
  const { start, end } = state.dateRange;
  return (start && end) ? `&start_date=${start}&end_date=${end}` : '';
}

// ==================== EDIT AD GROUP TAB ====================
let _editContext = { account_id: null, ad_group_id: null, ad_resource_name: null, creatives: [] };

function getEditSelectedAccountIds(){ return pickerSelected(editAccountsContainer); }
function getEditSelectedCampaignIds(){ return pickerSelected(editCampaignsContainer); }

function hideEditPanels(){
  editCreativesPanel.classList.add('hidden');
  editAddPanel.classList.add('hidden');
  editResults.classList.add('hidden');
}

async function onEditAccountChange(){
  const ids = getEditSelectedAccountIds();
  setPickerPlaceholder(editAdgroupsContainer, 'Select campaigns first');
  _editContext = { account_id: null, ad_group_id: null, ad_resource_name: null, creatives: [] };
  hideEditPanels();
  if(!ids.length){ setPickerPlaceholder(editCampaignsContainer, 'Select accounts first'); return; }
  setPickerLoading(editCampaignsContainer, 'Loading campaigns...');
  try{
    const resp=await fetch(`/api/all_campaigns?account_ids=${ids.join(',')}&show_all=${pickerFlags.editCampaigns}`);
    const data=await resp.json();
    if(!resp.ok) throw new Error(data.detail||'Failed to load campaigns');
    createPicker(editCampaignsContainer, {
      items: data.campaigns.map(c => ({ id: c.id, name: c.name, status: c.status })),
      showAllToggle: true,
      showAll: pickerFlags.editCampaigns,
      emptyText: 'No campaigns found',
      onChange: () => onEditCampaignChange(),
      onShowAllChange: (v) => { pickerFlags.editCampaigns = v; onEditAccountChange(); }
    });
  }catch(e){ setPickerPlaceholder(editCampaignsContainer, `Error: ${e.message}`); }
}

async function onEditCampaignChange(){
  const accountIds=getEditSelectedAccountIds();
  const campaignIds=getEditSelectedCampaignIds();
  _editContext = { account_id: null, ad_group_id: null, ad_resource_name: null, creatives: [] };
  hideEditPanels();
  if(!campaignIds.length){ setPickerPlaceholder(editAdgroupsContainer, 'Select campaigns first'); return; }
  setPickerLoading(editAdgroupsContainer, 'Loading ad groups...');
  try{
    const resp=await fetch(`/api/adgroups?account_ids=${accountIds.join(',')}&campaign_ids=${campaignIds.join(',')}&show_all=${pickerFlags.editAdgroups}`);
    const data=await resp.json();
    if(!resp.ok) throw new Error(data.detail||'Failed to load ad groups');
    createPicker(editAdgroupsContainer, {
      items: data.adgroups.map(g => ({
        id: `${g.account_id}|${g.ad_group_id}`, name: g.ad_group_name, hint: g.campaign_name, status: g.status
      })),
      multi: false,
      showAllToggle: true,
      showAll: pickerFlags.editAdgroups,
      emptyText: 'No ad groups found',
      onChange: (ids) => { if (ids.length) onEditAdgroupSelected(ids[0]); },
      onShowAllChange: (v) => { pickerFlags.editAdgroups = v; onEditCampaignChange(); }
    });
  }catch(e){ setPickerPlaceholder(editAdgroupsContainer, `Error: ${e.message}`); }
}

async function onEditAdgroupSelected(key){
  const [accountId, adGroupId] = key.split('|');
  _editContext = { account_id: accountId, ad_group_id: adGroupId, ad_resource_name: null, creatives: [] };
  editResults.classList.add('hidden');
  await loadEditCreatives();
}

async function loadEditCreatives(){
  const { account_id, ad_group_id } = _editContext;
  if(!account_id || !ad_group_id) return;
  hideError(); showLoading();
  try{
    const resp=await fetch(`/api/adgroup_creatives?account_id=${account_id}&ad_group_id=${ad_group_id}${creativesDateParams()}`);
    const data=await resp.json();
    if(!resp.ok) throw new Error(data.detail||'Failed to load creatives');
    _editContext.ad_resource_name = data.ad_resource_name;
    _editContext.creatives = data.creatives;
    renderEditCreatives(data);
  }catch(e){ showError('Failed to load creatives: '+e.message); hideEditPanels(); }
  finally{ hideLoading(); }
}

function renderEditCreatives(data){
  editCreativesPanel.classList.remove('hidden');
  editAddPanel.classList.remove('hidden');
  document.getElementById('edit-creatives-count').textContent = `${data.count} videos`;
  editCreativesBody.innerHTML = (data.creatives||[]).map(c=>{
    const label = c.performance_label || 'UNRATED';
    const cls = 'perf-' + label.toLowerCase();
    const checked = label === 'LOW' ? 'checked' : '';
    const name = c.title || c.video_id || c.asset_resource;
    const nameHtml = c.video_id
      ? `<a href="https://youtu.be/${encodeURIComponent(c.video_id)}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`
      : escapeHtml(name);
    return `<tr>
      <td style="text-align:center;"><input type="checkbox" class="edit-remove-cb" data-asset="${escapeHtml(c.asset_resource)}" ${checked}></td>
      <td class="asset-name" title="${escapeHtml(name)}">${nameHtml}</td>
      <td><span class="perf-badge ${cls}">${escapeHtml(label)}</span></td>
      <td class="numeric cost-cell">${formatCurrency(c.cost)}</td>
      <td class="numeric impressions-cell">${formatNumber(c.impressions)}</td>
      <td class="numeric installs-cell">${formatNumber(c.installs)}</td>
      <td class="numeric">${(c.cvr||0).toFixed(2)}%</td>
    </tr>`;
  }).join('');
}

async function applyReplace(){
  if(!_editContext.ad_resource_name){ return showError('Select an ad group first'); }
  const removeAssets = Array.from(document.querySelectorAll('.edit-remove-cb:checked')).map(cb=>cb.dataset.asset);
  const addUrls = editAddUrls.value.trim().split('\n').map(s=>s.trim()).filter(Boolean);
  if(!removeAssets.length && !addUrls.length){ return showError('Nothing to change — check videos to remove or add new URLs'); }

  const remaining = _editContext.creatives.length - removeAssets.length + addUrls.length;
  if(remaining <= 0){ return showError('You must keep at least one video in the ad group'); }
  if(!confirm(`Remove ${removeAssets.length} video(s) and add ${addUrls.length}. Continue?`)) return;

  hideError(); showLoading();
  try{
    const resp=await fetch('/api/replace_creatives',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      account_id: _editContext.account_id,
      ad_resource_name: _editContext.ad_resource_name,
      remove_asset_resources: removeAssets,
      add_youtube_urls: addUrls
    })});
    const data=await resp.json();
    if(!resp.ok) throw new Error(data.detail||'Failed to apply changes');
    renderEditResults(data);
    if(data.success){
      editAddUrls.value='';
      await loadEditCreatives();  // refresh table to reflect the new state
    }
  }catch(e){ showError('Failed to apply changes: '+e.message); }
  finally{ hideLoading(); }
}

function renderEditResults(data){
  editResults.classList.remove('hidden');
  const logsHtml = data.logs ? `<div class="upload-logs">${data.logs.map(l=>`<div class="log-line">${escapeHtml(l)}</div>`).join('')}</div>` : '';
  if(data.success){
    editLog.innerHTML = `<div class="upload-log-item success">
      <div class="log-header">✓ Updated — removed ${data.removed}, added ${data.added}, total now ${data.total_after}</div>
      ${logsHtml}
    </div>`;
  } else {
    editLog.innerHTML = `<div class="upload-log-item error">
      <div class="log-header">✗ ${escapeHtml(data.error||'Failed')}</div>
      ${logsHtml}
    </div>`;
  }
}

// ==================== MIGRATE 2ND TOUCH TAB ====================
// Multi-donor -> multi-target. byGroup maps "account|adGroupId" to that group's
// loaded context; both tables render a union of creatives deduped by video_id
// (creatives are named identically across channels/campaigns).
let _migrate = {
  src: { byGroup: {}, order: [], meta: {} },
  dst: { byGroup: {}, order: [], meta: {} }
};

const MIGRATE_LABEL_ORDER = { BEST: 0, GOOD: 1, LEARNING: 2, PENDING: 3, UNRATED: 4, LOW: 5 };
function migrateBestLabel(labels){
  return Object.keys(labels).sort((a,b)=>(MIGRATE_LABEL_ORDER[a]??9)-(MIGRATE_LABEL_ORDER[b]??9))[0] || 'UNRATED';
}
function migrateWorstRank(labels){
  return Math.max(...Object.keys(labels).map(l => MIGRATE_LABEL_ORDER[l] ?? 9));
}

function getMigrateSelectedAccountIds(pane){ return pickerSelected(migratePanes[pane].accounts); }
function getMigrateSelectedCampaignIds(pane){ return pickerSelected(migratePanes[pane].campaigns); }

function resetMigratePane(pane){
  _migrate[pane].byGroup = {};
  _migrate[pane].order = [];
  migratePanes[pane].panel.classList.add('hidden');
}

async function onMigrateAccountChange(pane){
  const p = migratePanes[pane];
  const ids = getMigrateSelectedAccountIds(pane);
  setPickerPlaceholder(p.adgroups, 'Select campaigns first');
  resetMigratePane(pane);
  updateMigrateSummary();
  if(!ids.length){ setPickerPlaceholder(p.campaigns, 'Select accounts first'); return; }
  setPickerLoading(p.campaigns, 'Loading campaigns...');
  const flagKey = pane + 'Campaigns';
  try{
    const resp=await fetch(`/api/all_campaigns?account_ids=${ids.join(',')}&show_all=${pickerFlags[flagKey]}`);
    const data=await resp.json();
    if(!resp.ok) throw new Error(data.detail||'Failed to load campaigns');
    createPicker(p.campaigns, {
      items: data.campaigns.map(c => ({ id: c.id, name: c.name, status: c.status })),
      showAllToggle: true,
      showAll: pickerFlags[flagKey],
      emptyText: 'No campaigns found',
      onChange: () => onMigrateCampaignChange(pane),
      onShowAllChange: (v) => { pickerFlags[flagKey] = v; onMigrateAccountChange(pane); }
    });
  }catch(e){ setPickerPlaceholder(p.campaigns, `Error: ${e.message}`); }
}

async function onMigrateCampaignChange(pane){
  const p = migratePanes[pane];
  const accountIds = getMigrateSelectedAccountIds(pane);
  const campaignIds = getMigrateSelectedCampaignIds(pane);
  resetMigratePane(pane);
  updateMigrateSummary();
  if(!campaignIds.length){ setPickerPlaceholder(p.adgroups, 'Select campaigns first'); return; }
  setPickerLoading(p.adgroups, 'Loading ad groups...');
  const flagKey = pane + 'Adgroups';
  try{
    const resp=await fetch(`/api/adgroups?account_ids=${accountIds.join(',')}&campaign_ids=${campaignIds.join(',')}&show_all=${pickerFlags[flagKey]}`);
    const data=await resp.json();
    if(!resp.ok) throw new Error(data.detail||'Failed to load ad groups');
    // Remember names for tooltips/logs
    _migrate[pane].meta = {};
    data.adgroups.forEach(g => {
      _migrate[pane].meta[`${g.account_id}|${g.ad_group_id}`] = {
        campaign_name: g.campaign_name, ad_group_name: g.ad_group_name
      };
    });
    createPicker(p.adgroups, {
      items: data.adgroups.map(g => ({
        id: `${g.account_id}|${g.ad_group_id}`, name: g.ad_group_name, hint: g.campaign_name, status: g.status
      })),
      showAllToggle: true,
      showAll: pickerFlags[flagKey],
      emptyText: 'No ad groups found',
      onChange: (ids) => onMigrateAdgroupsChanged(pane, ids),
      onShowAllChange: (v) => { pickerFlags[flagKey] = v; onMigrateCampaignChange(pane); }
    });
  }catch(e){ setPickerPlaceholder(p.adgroups, `Error: ${e.message}`); }
}

async function onMigrateAdgroupsChanged(pane, keys){
  const ctx = _migrate[pane];
  ctx.order = keys.slice();
  // Drop groups that were unselected
  Object.keys(ctx.byGroup).forEach(k => { if(!keys.includes(k)) delete ctx.byGroup[k]; });
  const toLoad = keys.filter(k => !ctx.byGroup[k]);
  if(toLoad.length){
    hideError(); showLoading();
    try{
      await Promise.all(toLoad.map(async k => {
        const [accountId, adGroupId] = k.split('|');
        const resp = await fetch(`/api/adgroup_creatives?account_id=${accountId}&ad_group_id=${adGroupId}${creativesDateParams()}`);
        const data = await resp.json();
        if(!resp.ok) throw new Error(data.detail || 'Failed to load creatives');
        const meta = ctx.meta[k] || {};
        ctx.byGroup[k] = {
          key: k,
          account_id: accountId,
          ad_group_id: adGroupId,
          ad_resource_name: data.ad_resource_name,
          creatives: data.creatives || [],
          campaign_name: meta.campaign_name || '',
          ad_group_name: meta.ad_group_name || ''
        };
      }));
    }catch(e){ showError('Failed to load creatives: '+e.message); }
    finally{ hideLoading(); }
  }
  renderMigratePane(pane);
  updateMigrateSummary();
}

// Union of creatives across the pane's groups, deduped by video_id.
function buildMigrateUnion(ctx){
  const map = new Map();
  const unmatched = [];  // creatives without a video_id can't be merged across groups
  for(const k of ctx.order){
    const g = ctx.byGroup[k];
    if(!g) continue;
    for(const c of g.creatives){
      const label = c.performance_label || 'UNRATED';
      if(!c.video_id){
        unmatched.push({ ...c, label, group: g });
        continue;
      }
      let row = map.get(c.video_id);
      if(!row){
        row = { video_id: c.video_id, title: c.title || c.video_id, labels: {}, cost: 0, impressions: 0, installs: 0, groups: [] };
        map.set(c.video_id, row);
      }
      if(c.title && (!row.title || row.title === row.video_id)) row.title = c.title;
      row.labels[label] = (row.labels[label] || 0) + 1;
      row.cost += c.cost || 0;
      row.impressions += c.impressions || 0;
      row.installs += c.installs || 0;
      row.groups.push({ key: k, campaign_name: g.campaign_name, asset_resource: c.asset_resource, label });
    }
  }
  const rows = Array.from(map.values());
  rows.forEach(r => { r.cvr = r.impressions ? (r.installs / r.impressions * 100) : 0; });
  return { rows, unmatched };
}

function renderMigratePane(pane){
  const p = migratePanes[pane];
  const ctx = _migrate[pane];
  const groupsCount = ctx.order.filter(k => ctx.byGroup[k]).length;
  if(!groupsCount){ p.panel.classList.add('hidden'); p.body.innerHTML=''; return; }
  p.panel.classList.remove('hidden');

  const { rows, unmatched } = buildMigrateUnion(ctx);
  p.count.textContent = `${rows.length + unmatched.length} unique videos · ${groupsCount} group${groupsCount>1?'s':''}`;

  if(pane === 'src'){
    rows.sort((a,b) => (MIGRATE_LABEL_ORDER[migrateBestLabel(a.labels)]??9) - (MIGRATE_LABEL_ORDER[migrateBestLabel(b.labels)]??9) || b.cost - a.cost);
  } else {
    rows.sort((a,b) => migrateWorstRank(b.labels) - migrateWorstRank(a.labels) || b.cost - a.cost);
  }

  const html = rows.map(r => {
    const nameHtml = `<a href="https://youtu.be/${encodeURIComponent(r.video_id)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a>`;
    if(pane === 'src'){
      const label = migrateBestLabel(r.labels);
      const multi = r.groups.length > 1 ? ` <span class="mig-groups-badge">×${r.groups.length}</span>` : '';
      return `<tr>
        <td style="text-align:center;"><input type="checkbox" class="mig-src-cb" data-vid="${escapeHtml(r.video_id)}" onchange="updateMigrateSummary()"></td>
        <td class="asset-name" title="${escapeHtml(r.title)}">${nameHtml}${multi}</td>
        <td><span class="perf-badge perf-${label.toLowerCase()}">${escapeHtml(label)}</span></td>
        <td class="numeric cost-cell">${formatCurrency(r.cost)}</td>
        <td class="numeric installs-cell">${formatNumber(r.installs)}</td>
        <td class="numeric">${r.cvr.toFixed(2)}%</td>
      </tr>`;
    }
    // dst: all labels with counts + In column (which campaigns contain it)
    const badges = Object.entries(r.labels)
      .sort((a,b)=>(MIGRATE_LABEL_ORDER[b[0]]??9)-(MIGRATE_LABEL_ORDER[a[0]]??9))
      .map(([l,cnt])=>`<span class="perf-badge perf-${l.toLowerCase()}">${escapeHtml(l)}${cnt>1?` ×${cnt}`:''}</span>`)
      .join(' ');
    const inTitle = r.groups.map(g => g.campaign_name || g.key).join('\n');
    return `<tr>
      <td style="text-align:center;"><input type="checkbox" class="mig-remove-cb" data-vid="${escapeHtml(r.video_id)}" onchange="updateMigrateSummary()"></td>
      <td class="asset-name" title="${escapeHtml(r.title)}">${nameHtml}</td>
      <td><div class="perf-badges">${badges}</div></td>
      <td class="numeric mig-in-cell" title="${escapeHtml(inTitle)}">${r.groups.length}/${groupsCount}</td>
      <td class="numeric cost-cell">${formatCurrency(r.cost)}</td>
      <td class="numeric installs-cell">${formatNumber(r.installs)}</td>
      <td class="numeric">${r.cvr.toFixed(2)}%</td>
    </tr>`;
  }).join('');

  const unmatchedHtml = unmatched.map(c => {
    const name = c.title || c.asset_resource;
    const where = c.group.campaign_name || c.group.ad_group_name || '';
    const cb = pane === 'src'
      ? `<input type="checkbox" class="mig-src-cb" disabled title="No video id — cannot copy">`
      : `<input type="checkbox" class="mig-remove-cb" data-asset="${escapeHtml(c.asset_resource)}" onchange="updateMigrateSummary()">`;
    const inCell = pane === 'src' ? '' : `<td class="numeric mig-in-cell" title="${escapeHtml(where)}">1/${groupsCount}</td>`;
    return `<tr>
      <td style="text-align:center;">${cb}</td>
      <td class="asset-name" title="${escapeHtml(name)}">${escapeHtml(name)} <span class="mig-unmatched">· ${escapeHtml(where)}</span></td>
      <td><span class="perf-badge perf-${(c.label||'UNRATED').toLowerCase()}">${escapeHtml(c.label||'UNRATED')}</span></td>
      ${inCell}
      <td class="numeric cost-cell">${formatCurrency(c.cost||0)}</td>
      <td class="numeric installs-cell">${formatNumber(c.installs||0)}</td>
      <td class="numeric">${(c.cvr||0).toFixed(2)}%</td>
    </tr>`;
  }).join('');

  p.body.innerHTML = html + unmatchedHtml;
  updateMigrateSummary();
}

function getMigrateAddVideoIds(){
  return Array.from(document.querySelectorAll('#src-creatives-body .mig-src-cb:checked'))
    .map(cb=>cb.dataset.vid).filter(Boolean);
}
function getMigrateRemoveSelection(){
  const vids = new Set();
  const assets = new Set();
  document.querySelectorAll('#dst-creatives-body .mig-remove-cb:checked').forEach(cb => {
    if (cb.dataset.vid) vids.add(cb.dataset.vid);
    else if (cb.dataset.asset) assets.add(cb.dataset.asset);
  });
  return { vids, assets };
}

// Per destination group: which asset_resources to remove and the predicted
// final video count after (current − removed) ∪ added.
function computeDstPlans(){
  const addVids = new Set(getMigrateAddVideoIds());
  const { vids: removeVids, assets: removeAssets } = getMigrateRemoveSelection();
  const ctx = _migrate.dst;
  return ctx.order.filter(k => ctx.byGroup[k]).map(k => {
    const g = ctx.byGroup[k];
    const groupRemoveAssets = [];
    const remainingVids = new Set();
    let remainingNoVid = 0;
    for(const c of g.creatives){
      const removed = (c.video_id && removeVids.has(c.video_id)) || removeAssets.has(c.asset_resource);
      if(removed){ groupRemoveAssets.push(c.asset_resource); continue; }
      if(c.video_id) remainingVids.add(c.video_id); else remainingNoVid++;
    }
    let finalCount = remainingVids.size + remainingNoVid;
    for(const v of addVids){ if(!remainingVids.has(v)) finalCount++; }
    return { group: g, removeAssets: groupRemoveAssets, finalCount };
  });
}

function updateMigrateSummary(){
  const hasDst = _migrate.dst.order.some(k => _migrate.dst.byGroup[k]);
  if(!hasDst){ migrateFooter.classList.add('hidden'); return; }
  migrateFooter.classList.remove('hidden');
  const plans = computeDstPlans();
  const addIds = getMigrateAddVideoIds();
  const removeTotal = plans.reduce((s,p)=>s+p.removeAssets.length,0);
  const counts = plans.map(p=>p.finalCount);
  const min = Math.min(...counts), max = Math.max(...counts);
  const invalid = plans.filter(p => p.finalCount < 1 || p.finalCount > 20);
  let html =
    `Copy <strong>${addIds.length}</strong> → <strong>${plans.length}</strong> group${plans.length>1?'s':''} · ` +
    `remove <strong>${removeTotal}</strong> · after: <strong>${min===max?min:`${min}–${max}`}</strong> videos per group`;
  if(invalid.length){
    html += `<div class="migrate-summary-lines">${invalid.map(p =>
      `<div class="summary-warn">${escapeHtml(p.group.campaign_name || p.group.ad_group_name || p.group.key)}: would have ${p.finalCount}${p.finalCount>20?' (>20)':''}</div>`
    ).join('')}</div>`;
  }
  migrateSummary.innerHTML = html;
  migrateApplyBtn.disabled = invalid.length > 0 || (addIds.length === 0 && removeTotal === 0);
}

async function applyMigration(){
  const plans = computeDstPlans();
  if(!plans.length){ return showError('Select at least one destination ad group'); }
  const addIds = getMigrateAddVideoIds();
  const removeTotal = plans.reduce((s,p)=>s+p.removeAssets.length,0);
  if(!addIds.length && !removeTotal){ return showError('Nothing to transfer — pick videos to copy on the left and/or remove on the right'); }
  const invalid = plans.filter(p => p.finalCount < 1 || p.finalCount > 20);
  if(invalid.length){ return showError('Some target groups would end up empty or over the 20-video limit — adjust selection'); }
  if(!confirm(`Copy ${addIds.length} video(s) into ${plans.length} ad group(s) and remove ${removeTotal} video occurrence(s). Continue?`)) return;

  hideError(); showLoading();
  const results = [];
  try{
    // Sequential: one request per destination group; a failure doesn't stop the rest.
    for(const p of plans){
      try{
        const resp = await fetch('/api/replace_creatives',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
          account_id: p.group.account_id,
          ad_resource_name: p.group.ad_resource_name,
          remove_asset_resources: p.removeAssets,
          add_youtube_urls: addIds
        })});
        const data = await resp.json();
        if(!resp.ok) results.push({ group: p.group, success: false, error: data.detail || 'Failed', logs: data.logs });
        else results.push({ group: p.group, ...data });
      }catch(e){
        results.push({ group: p.group, success: false, error: e.message });
      }
    }
    renderMigrateResults(results);
    // Refresh all destination tables to reflect the new state
    const keys = _migrate.dst.order.slice();
    _migrate.dst.byGroup = {};
    await onMigrateAdgroupsChanged('dst', keys);
  }finally{ hideLoading(); updateMigrateSummary(); }
}

function renderMigrateResults(results){
  migrateResults.classList.remove('hidden');
  migrateLog.innerHTML = results.map(r => {
    const g = r.group || {};
    const gname = `${g.campaign_name ? escapeHtml(g.campaign_name) + ' / ' : ''}${escapeHtml(g.ad_group_name || ('#' + (g.ad_group_id || '?')))}`;
    const logsHtml = r.logs ? `<div class="upload-logs">${r.logs.map(l=>`<div class="log-line">${escapeHtml(l)}</div>`).join('')}</div>` : '';
    if(r.success){
      return `<div class="upload-log-item success">
        <div class="log-header">✓ ${gname} — added ${r.added}, removed ${r.removed}, now ${r.total_after} videos</div>
        ${logsHtml}
      </div>`;
    }
    return `<div class="upload-log-item error">
      <div class="log-header">✗ ${gname} — ${escapeHtml(r.error || 'Failed')}</div>
      ${logsHtml}
    </div>`;
  }).join('');
}

// ==================== DASHBOARD TAB ====================
let _chartGoogle, _chartApplovin, _chartMintegral, _chartCvr;

function initializeDashboardDefaults(){
  // Load saved app selection
  if (dashAppSelect) {
    const savedApp = localStorage.getItem('dash_app_token');
    if (savedApp) dashAppSelect.value = savedApp;
    dashAppSelect.addEventListener('change', () => {
      localStorage.setItem('dash_app_token', dashAppSelect.value);
    });
  }

  // Setup accounts dropdown
  if (dashAccountsToggle && dashAccountsMenu) {
    dashAccountsToggle.addEventListener('click', () => {
      dashAccountsMenu.classList.toggle('hidden');
      if (!dashAccountsLoaded) {
        loadDashboardAccounts();
      }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#dash-accounts-dropdown')) {
        dashAccountsMenu.classList.add('hidden');
      }
    });
  }
}

async function loadDashboardAccounts() {
  if (dashAccountsLoaded) return;

  try {
    const resp = await fetch('/api/accounts');
    const text = await resp.text();
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      try { msg = JSON.parse(text).detail || msg; } catch(_) { msg = text || msg; }
      throw new Error(msg);
    }
    const data = JSON.parse(text);

    dashAccountsLoaded = true;
    renderDashboardAccounts(data.accounts);
  } catch (e) {
    dashAccountsMenu.innerHTML = `<div class="dropdown-loading">Error: ${e.message}</div>`;
  }
}

function renderDashboardAccounts(accounts) {
  dashAccountsMenu.innerHTML = `
    <div class="dropdown-actions">
      <button onclick="selectAllDashAccounts(true)">Select All</button>
      <button onclick="selectAllDashAccounts(false)">Deselect All</button>
    </div>
    ${accounts.map(acc => `
      <label class="dropdown-item">
        <input type="checkbox" value="${acc.id}" data-name="${escapeHtml(acc.name)}">
        <span title="${escapeHtml(acc.name)}">${escapeHtml(acc.name)}</span>
      </label>
    `).join('')}
  `;

  // Update toggle text on change
  dashAccountsMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', updateDashAccountsToggle);
  });
}

function selectAllDashAccounts(select) {
  dashAccountsMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = select);
  updateDashAccountsToggle();
}

function updateDashAccountsToggle() {
  const checked = dashAccountsMenu.querySelectorAll('input[type="checkbox"]:checked');
  const toggle = dashAccountsToggle.querySelector('.dropdown-placeholder, .dropdown-selected');

  if (checked.length === 0) {
    toggle.className = 'dropdown-placeholder';
    toggle.textContent = 'Select accounts...';
  } else if (checked.length === 1) {
    toggle.className = 'dropdown-selected';
    toggle.textContent = checked[0].dataset.name;
  } else {
    toggle.className = 'dropdown-selected';
    toggle.textContent = `${checked.length} accounts selected`;
  }
}

function getSelectedDashAccountIds() {
  return Array.from(dashAccountsMenu.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}

function ensureCharts(){
  if (window.echarts) {
    if (chartGoogleEl && !_chartGoogle) _chartGoogle = echarts.init(chartGoogleEl);
    if (chartApplovinEl && !_chartApplovin) _chartApplovin = echarts.init(chartApplovinEl);
    if (chartMintegralEl && !_chartMintegral) _chartMintegral = echarts.init(chartMintegralEl);
    if (chartCvrEl && !_chartCvr) _chartCvr = echarts.init(chartCvrEl);
    window.addEventListener('resize', () => {
      _chartGoogle && _chartGoogle.resize();
      _chartApplovin && _chartApplovin.resize();
      _chartMintegral && _chartMintegral.resize();
      _chartCvr && _chartCvr.resize();
    });
  }
}

function setEmptyChart(chart, title, subtitle){
  if (!chart) return;
  chart.setOption({
    title: {
      text: title,
      subtext: subtitle || 'No data',
      left: 'center',
      textStyle: { color: '#ffffff', fontSize: 14 },
      subtextStyle: { color: 'rgba(255,255,255,0.72)', fontSize: 12 }
    },
    xAxis: { show: false },
    yAxis: { show: false },
    series: []
  }, true);
}

function buildCvrLineChart(dates, cvrData) {
  const colors = {
    google: '#58a6ff',
    applovin: '#a371f7',
    mintegral: '#3fb950'
  };

  return {
    color: [colors.google, colors.applovin, colors.mintegral],
    grid: { left: 50, right: 20, top: 20, bottom: 40, containLabel: true },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        if (!params || !params.length) return '';
        let html = `<strong>${params[0].name}</strong><br/>`;
        params.forEach(p => {
          html += `${p.marker} ${p.seriesName}: ${p.data.toFixed(3)}%<br/>`;
        });
        return html;
      }
    },
    legend: {
      data: ['Google', 'AppLovin', 'Mintegral'],
      bottom: 0,
      textStyle: { color: 'rgba(255,255,255,0.72)' }
    },
    xAxis: {
      type: 'category',
      data: dates,
      axisLabel: {
        color: 'rgba(255,255,255,0.72)',
        fontSize: 10,
        rotate: dates.some(d => d.includes(' - ')) ? 45 : 0,
        interval: 0,
        formatter: (value) => {
          if (value.includes(' - ')) {
            const [start, end] = value.split(' - ');
            const startDate = new Date(start);
            const endDate = new Date(end);
            if (startDate.getMonth() === endDate.getMonth()) {
              return `${startDate.getDate()}-${endDate.getDate()} ${startDate.toLocaleDateString('en-US', { month: 'short' })}`;
            }
            return `${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
          }
          return value;
        }
      }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: 'rgba(255,255,255,0.72)', formatter: '{value}%' },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } }
    },
    series: [
      {
        name: 'Google',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 4,
        data: cvrData.google || [],
        lineStyle: { width: 2 }
      },
      {
        name: 'AppLovin',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 4,
        data: cvrData.applovin || [],
        lineStyle: { width: 2 }
      },
      {
        name: 'Mintegral',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 4,
        data: cvrData.mintegral || [],
        lineStyle: { width: 2 }
      }
    ]
  };
}

function buildStacked100Option(dates, series){
  const palette = ['#58a6ff','#a371f7','#3fb950','#f0883e','#f85149','#8b949e','#d2a8ff','#79c0ff','#56d364','#ffa657'];
  return {
    color: palette,
    grid: { left: 40, right: 20, top: 20, bottom: 30, containLabel: true },
    tooltip: {
      trigger: 'item',
      formatter: (params) => {
        if (!params) return '';
        const day = params.name;
        const pct = (params.data || 0);
        const seriesData = params.seriesIndex != null ? series[params.seriesIndex] : null;
        const cost = seriesData && seriesData.dataCost ? seriesData.dataCost[params.dataIndex] : null;
        const costTxt = cost != null ? `<br/>Cost: $${Number(cost).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}` : '';
        return `<strong>${day}</strong><br/>${escapeHtml(params.seriesName)}: ${pct.toFixed(1)}%${costTxt}`;
      }
    },
    xAxis: {
      type: 'category',
      data: dates,
      axisLabel: {
        color: 'rgba(255,255,255,0.72)',
        fontSize: 11,
        rotate: dates.some(d => d.includes(' - ')) ? 45 : 0,
        interval: 0,
        formatter: (value) => {
          if (value.includes(' - ')) {
            const [start, end] = value.split(' - ');
            const startDate = new Date(start);
            const endDate = new Date(end);
            if (startDate.getMonth() === endDate.getMonth()) {
              return `${startDate.getDate()}-${endDate.getDate()} ${startDate.toLocaleDateString('en-US', { month: 'short' })}`;
            }
            return `${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
          }
          return value;
        }
      }
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      axisLabel: { color: 'rgba(255,255,255,0.72)', formatter: '{value}%' }
    },
    series: series.map((s, idx) => ({
      name: s.name,
      type: 'line',
      smooth: true,
      showSymbol: true,
      symbol: 'circle',
      symbolSize: 4,
      stack: 'total',
      areaStyle: { opacity: 0.35 },
      emphasis: {
        focus: 'series',
        scale: true,
        symbolSize: 10
      },
      data: s.dataPct,
      dataCost: s.dataCost,
      lineStyle: { width: 1.5 }
    })),
    legend: {
      type: 'scroll',
      bottom: 0,
      textStyle: { color: 'rgba(255,255,255,0.72)' }
    }
  };
}

// Store dashboard data for interactivity
let _dashboardData = { google: null, applovin: null, mintegral: null };
let _selectedSeries = { google: null, applovin: null, mintegral: null };

async function loadDashboard(){
  // Global period drives the dashboard too
  const sd = state.dateRange.start, ed = state.dateRange.end;

  const platform = dashPlatformSelect ? dashPlatformSelect.value : 'Android';
  const groupBy = 'day';  // Only daily grouping supported
  const adjustAppToken = dashAppSelect ? dashAppSelect.value : '';
  const accountIds = getSelectedDashAccountIds();

  if(!sd || !ed) return showError('Please select date range');
  if(!adjustAppToken) return showError('Please select an app');
  if(!accountIds.length) return showError('Please select at least one account');

  hideError(); showLoading();
  ensureCharts();
  setEmptyChart(_chartGoogle, 'Loading...', '');
  setEmptyChart(_chartApplovin, 'Loading...', '');
  setEmptyChart(_chartMintegral, 'Loading...', '');
  setEmptyChart(_chartCvr, 'Loading...', '');
  setEmptyList(listGoogleEl);
  setEmptyList(listApplovinEl);
  setEmptyList(listMintegralEl);

  try{
    const resp = await fetch('/api/dashboard', {
      method:'POST',
      headers:{
        'Content-Type':'application/json'
      },
      body: JSON.stringify({
        adgroup_type: 'main',
        test_date: '',
        start_date: sd,
        end_date: ed,
        platform: platform,
        adjust_app_token: adjustAppToken,
        account_ids: accountIds,
        group_by: groupBy
      })
    });
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.detail||'Failed to load dashboard');

    _dashboardData = { google: data.google, applovin: data.applovin, mintegral: data.mintegral };
    _selectedSeries = { google: null, applovin: null, mintegral: null };

    // CVR Chart
    if (data.cvr && data.cvr.dates) {
      _chartCvr.setOption(buildCvrLineChart(data.cvr.dates, data.cvr), true);
    } else {
      setEmptyChart(_chartCvr, 'CVR', 'No data');
    }

    // Google
    renderDashboardCard('google', data.google, _chartGoogle, listGoogleEl);
    // AppLovin
    renderDashboardCard('applovin', data.applovin, _chartApplovin, listApplovinEl);
    // Mintegral
    renderDashboardCard('mintegral', data.mintegral, _chartMintegral, listMintegralEl);

  }catch(e){
    showError('Failed to load dashboard: ' + e.message);
  }finally{
    hideLoading();
  }
}

function setEmptyList(listEl) {
  if (!listEl) return;
  listEl.innerHTML = '<div class="dashboard-list-empty">No data</div>';
}

function renderDashboardCard(key, data, chart, listEl) {
  if (!data || !data.dates || !data.series || !data.series.length) {
    setEmptyChart(chart, key.charAt(0).toUpperCase() + key.slice(1), 'No data');
    setEmptyList(listEl);
    return;
  }

  // Render chart
  chart.setOption(buildStacked100Option(data.dates, data.series), true);

  // Render list with avg % spend, total cost and CVR
  const seriesWithAvg = data.series.map(s => {
    const avg = s.dataPct.reduce((a, b) => a + b, 0) / s.dataPct.length;
    const totalCost = s.dataCost.reduce((a, b) => a + b, 0);
    const cvr = s.cvr || 0;
    return { name: s.name, avgPct: avg, totalCost: totalCost, cvr: cvr };
  }).sort((a, b) => b.avgPct - a.avgPct);

  listEl.innerHTML = seriesWithAvg.map((s, idx) => `
    <div class="dashboard-list-item" data-key="${key}" data-name="${escapeHtml(s.name)}" data-idx="${idx}">
      <span class="item-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
      <span class="item-stats">
        <span class="item-cost">$${formatCompactNumber(s.totalCost)}</span>
        <span class="item-cvr">${s.cvr.toFixed(2)}%</span>
        <span class="item-pct">${s.avgPct.toFixed(1)}%</span>
      </span>
    </div>
  `).join('');

  // Add click handlers
  listEl.querySelectorAll('.dashboard-list-item').forEach(item => {
    item.addEventListener('click', () => onListItemClick(key, item.dataset.name));
  });
}

function formatCompactNumber(num) {
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'k';
  }
  return num.toFixed(0);
}

function onListItemClick(key, seriesName) {
  const chart = key === 'google' ? _chartGoogle : key === 'applovin' ? _chartApplovin : _chartMintegral;
  const listEl = key === 'google' ? listGoogleEl : key === 'applovin' ? listApplovinEl : listMintegralEl;
  const data = _dashboardData[key];

  if (!chart || !data) return;

  // Toggle selection
  if (_selectedSeries[key] === seriesName) {
    _selectedSeries[key] = null;
  } else {
    _selectedSeries[key] = seriesName;
  }

  const selected = _selectedSeries[key];

  // Update list styling
  listEl.querySelectorAll('.dashboard-list-item').forEach(item => {
    item.classList.remove('active', 'dimmed');
    if (selected) {
      if (item.dataset.name === selected) {
        item.classList.add('active');
      } else {
        item.classList.add('dimmed');
      }
    }
  });

  // Highlight series on chart
  if (selected) {
    chart.dispatchAction({ type: 'highlight', seriesName: selected });
    chart.dispatchAction({ type: 'downplay' });
    chart.dispatchAction({ type: 'highlight', seriesName: selected });
  } else {
    chart.dispatchAction({ type: 'downplay' });
  }
}
