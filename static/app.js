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
  if (_migrate.src.ad_group_id) loadMigrateCreatives('src');
  if (_migrate.dst.ad_group_id) loadMigrateCreatives('dst');
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
let _migrate = {
  src: { account_id: null, ad_group_id: null, ad_resource_name: null, creatives: [] },
  dst: { account_id: null, ad_group_id: null, ad_resource_name: null, creatives: [] }
};

function getMigrateSelectedAccountIds(pane){ return pickerSelected(migratePanes[pane].accounts); }
function getMigrateSelectedCampaignIds(pane){ return pickerSelected(migratePanes[pane].campaigns); }

function resetMigratePane(pane){
  _migrate[pane] = { account_id: null, ad_group_id: null, ad_resource_name: null, creatives: [] };
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
    createPicker(p.adgroups, {
      items: data.adgroups.map(g => ({
        id: `${g.account_id}|${g.ad_group_id}`, name: g.ad_group_name, hint: g.campaign_name, status: g.status
      })),
      multi: false,
      showAllToggle: true,
      showAll: pickerFlags[flagKey],
      emptyText: 'No ad groups found',
      onChange: (ids) => { if (ids.length) onMigrateAdgroupSelected(pane, ids[0]); },
      onShowAllChange: (v) => { pickerFlags[flagKey] = v; onMigrateCampaignChange(pane); }
    });
  }catch(e){ setPickerPlaceholder(p.adgroups, `Error: ${e.message}`); }
}

async function onMigrateAdgroupSelected(pane, key){
  const [accountId, adGroupId] = key.split('|');
  _migrate[pane] = { account_id: accountId, ad_group_id: adGroupId, ad_resource_name: null, creatives: [] };
  await loadMigrateCreatives(pane);
}

async function loadMigrateCreatives(pane){
  const ctx = _migrate[pane];
  if(!ctx.account_id || !ctx.ad_group_id) return;
  hideError(); showLoading();
  try{
    const resp=await fetch(`/api/adgroup_creatives?account_id=${ctx.account_id}&ad_group_id=${ctx.ad_group_id}${creativesDateParams()}`);
    const data=await resp.json();
    if(!resp.ok) throw new Error(data.detail||'Failed to load creatives');
    ctx.ad_resource_name = data.ad_resource_name;
    ctx.creatives = data.creatives || [];
    renderMigrateCreatives(pane, data);
  }catch(e){ showError('Failed to load creatives: '+e.message); migratePanes[pane].panel.classList.add('hidden'); }
  finally{ hideLoading(); updateMigrateSummary(); }
}

function renderMigrateCreatives(pane, data){
  const p = migratePanes[pane];
  p.panel.classList.remove('hidden');
  p.count.textContent = `${data.count} videos`;
  let creatives = (data.creatives||[]).slice();
  if(pane === 'src'){
    const order = { BEST:0, GOOD:1, LEARNING:2, PENDING:3, UNRATED:4, LOW:5 };
    creatives.sort((a,b)=>(order[a.performance_label]??9)-(order[b.performance_label]??9));
  }
  // No auto-checking: the user picks what to copy / remove manually.
  p.body.innerHTML = creatives.map(c=>{
    const label = c.performance_label || 'UNRATED';
    const cls = 'perf-' + label.toLowerCase();
    const name = c.title || c.video_id || c.asset_resource;
    const nameHtml = c.video_id
      ? `<a href="https://youtu.be/${encodeURIComponent(c.video_id)}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`
      : escapeHtml(name);
    let cb;
    if(pane === 'src'){
      const disabled = c.video_id ? '' : 'disabled title="No video id — cannot copy"';
      cb = `<input type="checkbox" class="mig-src-cb" data-vid="${escapeHtml(c.video_id||'')}" ${disabled} onchange="updateMigrateSummary()">`;
    } else {
      cb = `<input type="checkbox" class="mig-remove-cb" data-asset="${escapeHtml(c.asset_resource)}" onchange="updateMigrateSummary()">`;
    }
    return `<tr>
      <td style="text-align:center;">${cb}</td>
      <td class="asset-name" title="${escapeHtml(name)}">${nameHtml}</td>
      <td><span class="perf-badge ${cls}">${escapeHtml(label)}</span></td>
      <td class="numeric cost-cell">${formatCurrency(c.cost)}</td>
      <td class="numeric installs-cell">${formatNumber(c.installs)}</td>
      <td class="numeric">${(c.cvr||0).toFixed(2)}%</td>
    </tr>`;
  }).join('');
  updateMigrateSummary();
}

function getMigrateAddVideoIds(){
  return Array.from(document.querySelectorAll('#src-creatives-body .mig-src-cb:checked'))
    .map(cb=>cb.dataset.vid).filter(Boolean);
}
function getMigrateRemoveAssets(){
  return Array.from(document.querySelectorAll('#dst-creatives-body .mig-remove-cb:checked'))
    .map(cb=>cb.dataset.asset);
}

function updateMigrateSummary(){
  const dst = _migrate.dst;
  if(!dst.ad_resource_name){ migrateFooter.classList.add('hidden'); return; }
  migrateFooter.classList.remove('hidden');
  const addIds = getMigrateAddVideoIds();
  const removeAssets = getMigrateRemoveAssets();
  const result = dst.creatives.length - removeAssets.length + addIds.length;
  let warn = '';
  if(result < 1) warn = ' — result would be empty';
  else if(result > 20) warn = ' — over the 20-video limit';
  migrateSummary.innerHTML =
    `Copy <strong>${addIds.length}</strong> Good/Best → remove <strong>${removeAssets.length}</strong> Low ` +
    `→ destination will have <strong>${result}</strong> videos` +
    (warn ? `<span class="summary-warn">${warn}</span>` : '');
  migrateApplyBtn.disabled = (result < 1 || result > 20 || (addIds.length===0 && removeAssets.length===0));
}

async function applyMigration(){
  const dst = _migrate.dst;
  if(!dst.ad_resource_name){ return showError('Select a destination ad group first'); }
  const addIds = getMigrateAddVideoIds();
  const removeAssets = getMigrateRemoveAssets();
  if(!addIds.length && !removeAssets.length){ return showError('Nothing to transfer — pick Good/Best on the left and/or Low on the right'); }
  const result = dst.creatives.length - removeAssets.length + addIds.length;
  if(result < 1){ return showError('Destination would have no videos left'); }
  if(result > 20){ return showError('Destination would exceed the 20-video limit'); }
  if(!confirm(`Copy ${addIds.length} video(s) into the destination and remove ${removeAssets.length} Low. Continue?`)) return;

  hideError(); showLoading();
  try{
    const resp=await fetch('/api/replace_creatives',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      account_id: dst.account_id,
      ad_resource_name: dst.ad_resource_name,
      remove_asset_resources: removeAssets,
      add_youtube_urls: addIds
    })});
    const data=await resp.json();
    if(!resp.ok) throw new Error(data.detail||'Failed to apply transfer');
    renderMigrateResults(data);
    if(data.success){ await loadMigrateCreatives('dst'); }  // refresh destination table
  }catch(e){ showError('Failed to apply transfer: '+e.message); }
  finally{ hideLoading(); updateMigrateSummary(); }
}

function renderMigrateResults(data){
  migrateResults.classList.remove('hidden');
  const logsHtml = data.logs ? `<div class="upload-logs">${data.logs.map(l=>`<div class="log-line">${escapeHtml(l)}</div>`).join('')}</div>` : '';
  if(data.success){
    migrateLog.innerHTML = `<div class="upload-log-item success">
      <div class="log-header">✓ Transfer done — added ${data.added}, removed ${data.removed}, destination now ${data.total_after} videos</div>
      ${logsHtml}
    </div>`;
  } else {
    migrateLog.innerHTML = `<div class="upload-log-item error">
      <div class="log-header">✗ ${escapeHtml(data.error||'Failed')}</div>
      ${logsHtml}
    </div>`;
  }
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
