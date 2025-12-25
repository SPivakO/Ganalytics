// State
let state = {
  accounts: [],
  campaigns: [],
  reportData: [],
  sortColumn: 'cost',
  sortDirection: 'desc',
  showAccount: false,
  showCampaign: true,
  dashboard: {
    google: null,
    applovin: null,
    mintegral: null
  }
};

// Reports DOM
const accountsContainer = document.getElementById('accounts-container');
const campaignsContainer = document.getElementById('campaigns-container');
const testDateInput = document.getElementById('test-date');
const startDateInput = document.getElementById('start-date');
const endDateInput = document.getElementById('end-date');
const loadBtn = document.getElementById('load-btn');
const downloadBtn = document.getElementById('download-btn');
const resultsPanel = document.getElementById('results-panel');
const resultsBody = document.getElementById('results-body');
const resultsThead = document.getElementById('results-thead');
const groupByAccountCheckbox = document.getElementById('group-by-account');
const groupByCampaignCheckbox = document.getElementById('group-by-campaign');

// Dashboard DOM
const dashPlatformSelect = document.getElementById('dash-platform');
const adjustAppTokenInput = document.getElementById('adjust-app-token');
const dashLoadBtn = document.getElementById('dash-load-btn');
const chartGoogleEl = document.getElementById('chart-google');
const chartApplovinEl = document.getElementById('chart-applovin');
const chartMintegralEl = document.getElementById('chart-mintegral');
const listGoogleEl = document.getElementById('list-google');
const listApplovinEl = document.getElementById('list-applovin');
const listMintegralEl = document.getElementById('list-mintegral');
const dashStartDateInput = document.getElementById('dash-start-date');
const dashEndDateInput = document.getElementById('dash-end-date');

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

// Common Elements
const loadingOverlay = document.getElementById('loading-overlay');
const errorMessage = document.getElementById('error-message');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initializeDates();
  initializeTabs();
  loadAccounts();
  setupEventListeners();
  initializeDashboardDefaults();
  initializeDashboardDates();
});

function initializeDates() {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  startDateInput.value = formatDate(firstDay);
  endDateInput.value = formatDate(lastDay);
}
function formatDate(d){return d.toISOString().split('T')[0];}

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
      testDateInput.disabled = e.target.value !== 'test';
      if(e.target.value==='test') testDateInput.focus();
    });
  });
  startDateInput.addEventListener('change', onDateChange);
  endDateInput.addEventListener('change', onDateChange);
  loadBtn.addEventListener('click', loadReport);
  downloadBtn.addEventListener('click', downloadCSV);
  uploadBtn.addEventListener('click', createTestAdGroups);
  if (dashLoadBtn) dashLoadBtn.addEventListener('click', loadDashboard);
}

// ==================== REPORTS TAB ====================
async function loadAccounts(){
  try{
    const resp = await fetch('/api/accounts'); const data = await resp.json();
    if(!resp.ok) throw new Error(data.detail||'Failed to load accounts');
    state.accounts = data.accounts;
    renderAccounts(accountsContainer,'onAccountChange');
    renderAccounts(uploadAccountsContainer,'onUploadAccountChange');
  }catch(e){showError('Failed to load accounts: '+e.message);}
}
function renderAccounts(container, handler){
  container.innerHTML = `
    <div class="select-actions">
      <button onclick="selectAll('${container.id}', true, ${handler})">Select All</button>
      <button onclick="selectAll('${container.id}', false, ${handler})">Deselect All</button>
    </div>
    <div class="checkbox-list">
      ${state.accounts.map(acc=>`
        <label class="checkbox-item">
          <input type="checkbox" value="${acc.id}" data-name="${escapeHtml(acc.name)}" onchange="${handler}()">
          <span title="${acc.name}">${acc.name}</span>
        </label>
      `).join('')}
    </div>`;
}
function selectAll(containerId, select, handler){
  const c=document.getElementById(containerId);
  c.querySelectorAll('input[type="checkbox"]').forEach(cb=>cb.checked=select);
  if(handler) handler();
}
function selectAllAccounts(select){selectAll('accounts-container',select,onAccountChange);}
function onDateChange(){ if(getSelectedAccountIds().length>0) onAccountChange(); }
async function onAccountChange(){
  const selectedIds=getSelectedAccountIds();
  if(!selectedIds.length){campaignsContainer.innerHTML='<div class="placeholder">Select accounts first</div>'; state.campaigns=[]; return;}
  const sd=startDateInput.value, ed=endDateInput.value;
  if(!sd||!ed){campaignsContainer.innerHTML='<div class="placeholder">Select date range first</div>'; return;}
  campaignsContainer.innerHTML='<div class="loading">Loading campaigns with spend...</div>';
  try{
    const resp=await fetch(`/api/campaigns?account_ids=${selectedIds.join(',')}&start_date=${sd}&end_date=${ed}`);
    const data=await resp.json();
    if(!resp.ok) throw new Error(data.detail||'Failed to load campaigns');
    state.campaigns=data.campaigns;
    renderCampaigns(campaignsContainer);
  }catch(e){
    campaignsContainer.innerHTML=`<div class="placeholder">Error: ${e.message}</div>`;
  }
}
function renderCampaigns(container){
  if(!state.campaigns.length){container.innerHTML='<div class="placeholder">No campaigns found</div>'; return;}
  container.innerHTML=`
    <div class="select-actions">
      <button onclick="selectAllCampaigns('${container.id}', true)">Select All</button>
      <button onclick="selectAllCampaigns('${container.id}', false)">Deselect All</button>
    </div>
    <div class="checkbox-list">
      ${state.campaigns.map(c=>`
        <label class="checkbox-item">
          <input type="checkbox" value="${c.id}" checked>
          <span title="${c.name}">${c.name}</span>
        </label>
      `).join('')}
    </div>`;
}
function selectAllCampaigns(id,select){const c=document.getElementById(id); c.querySelectorAll('input[type="checkbox"]').forEach(cb=>cb.checked=select);}
function getSelectedAccountIds(){return Array.from(accountsContainer.querySelectorAll('input[type="checkbox"]:checked')).map(cb=>cb.value);}
function getSelectedCampaignIds(){return Array.from(campaignsContainer.querySelectorAll('input[type="checkbox"]:checked')).map(cb=>cb.value);}

async function loadReport(){
  const accountIds=getSelectedAccountIds();
  const campaignIds=getSelectedCampaignIds();
  const adgroupType=document.querySelector('input[name="adgroup_type"]:checked').value;
  const testDate=testDateInput.value;
  const sd=startDateInput.value, ed=endDateInput.value;
  const groupByAccount=groupByAccountCheckbox.checked;
  const groupByCampaign=groupByCampaignCheckbox.checked;
  if(!accountIds.length){showError('Please select at least one account'); return;}
  if(!sd||!ed){showError('Please select date range'); return;}
  if(adgroupType==='test' && !testDate){showError('Please enter test date (e.g. 181225)'); return;}
  hideError(); showLoading();
  try{
    const resp=await fetch('/api/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      account_ids:accountIds,campaign_ids:campaignIds,adgroup_type:adgroupType,test_date:testDate,start_date:sd,end_date:ed,group_by_account:groupByAccount,group_by_campaign:groupByCampaign
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
  const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a'); link.href=url; link.download=`youtube_assets_${startDateInput.value}_${endDateInput.value}.csv`; link.click(); URL.revokeObjectURL(url);
}

// ==================== UPLOAD TAB ====================
async function onUploadAccountChange() {
  const selectedIds = getUploadSelectedAccountIds();
  if (!selectedIds.length) {
    uploadCampaignsContainer.innerHTML = '<div class="placeholder">Select accounts first</div>';
    return;
  }
  uploadCampaignsContainer.innerHTML = '<div class="loading">Loading campaigns...</div>';
  try {
    const response = await fetch(`/api/all_campaigns?account_ids=${selectedIds.join(',')}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Failed to load campaigns');
    renderUploadCampaigns(data.campaigns);
  } catch (e) {
    uploadCampaignsContainer.innerHTML = `<div class="placeholder">Error: ${e.message}</div>`;
  }
}

function renderUploadCampaigns(campaigns) {
  if (!campaigns.length) {
    uploadCampaignsContainer.innerHTML = '<div class="placeholder">No campaigns found</div>';
    return;
  }
  uploadCampaignsContainer.innerHTML = `
    <div class="select-actions">
      <button onclick="selectAllCampaigns('upload-campaigns-container', true)">Select All</button>
      <button onclick="selectAllCampaigns('upload-campaigns-container', false)">Deselect All</button>
    </div>
    <div class="checkbox-list">
      ${campaigns.map(camp => `
        <label class="checkbox-item">
          <input type="checkbox" value="${camp.id}">
          <span title="${camp.name}">${camp.name}</span>
        </label>
      `).join('')}
    </div>
  `;
}

function getUploadSelectedAccountIds() {
  return Array.from(uploadAccountsContainer.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}
function getUploadSelectedCampaignIds() {
  return Array.from(uploadCampaignsContainer.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
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

// ==================== DASHBOARD TAB ====================
let _chartGoogle, _chartApplovin, _chartMintegral;

function initializeDashboardDefaults(){
  if (adjustAppTokenInput && !adjustAppTokenInput.value) {
    const savedAppToken = localStorage.getItem('adjust_app_token');
    adjustAppTokenInput.value = savedAppToken || 'yypucqxkbu9s';
  }
  if (adjustAppTokenInput) {
    adjustAppTokenInput.addEventListener('change', () => {
      const v = adjustAppTokenInput.value.trim();
      if (v) localStorage.setItem('adjust_app_token', v);
    });
  }
}

function initializeDashboardDates(){
  if (!dashStartDateInput || !dashEndDateInput) return;
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  dashStartDateInput.value = formatDate(firstDay);
  dashEndDateInput.value = formatDate(lastDay);
}

function ensureCharts(){
  if (window.echarts) {
    if (chartGoogleEl && !_chartGoogle) _chartGoogle = echarts.init(chartGoogleEl);
    if (chartApplovinEl && !_chartApplovin) _chartApplovin = echarts.init(chartApplovinEl);
    if (chartMintegralEl && !_chartMintegral) _chartMintegral = echarts.init(chartMintegralEl);
    window.addEventListener('resize', () => {
      _chartGoogle && _chartGoogle.resize();
      _chartApplovin && _chartApplovin.resize();
      _chartMintegral && _chartMintegral.resize();
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
      textStyle: { color: '#e6edf3', fontSize: 14 },
      subtextStyle: { color: '#8b949e', fontSize: 12 }
    },
    xAxis: { show: false },
    yAxis: { show: false },
    series: []
  }, true);
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
      axisLabel: { color: '#8b949e', fontSize: 11 }
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      axisLabel: { color: '#8b949e', formatter: '{value}%' }
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
      textStyle: { color: '#8b949e' }
    }
  };
}

// Store dashboard data for interactivity
let _dashboardData = { google: null, applovin: null, mintegral: null };
let _selectedSeries = { google: null, applovin: null, mintegral: null };

async function loadDashboard(){
  const sd = dashStartDateInput ? dashStartDateInput.value : '';
  const ed = dashEndDateInput ? dashEndDateInput.value : '';
  const platform = dashPlatformSelect ? dashPlatformSelect.value : 'Android';
  const adjustAppToken = adjustAppTokenInput ? adjustAppTokenInput.value.trim() : '';

  if(!sd || !ed) return showError('Please select date range');
  if(!adjustAppToken) return showError('Please enter Adjust App Token');

  localStorage.setItem('adjust_app_token', adjustAppToken);

  hideError(); showLoading();
  ensureCharts();
  setEmptyChart(_chartGoogle, 'Loading...', '');
  setEmptyChart(_chartApplovin, 'Loading...', '');
  setEmptyChart(_chartMintegral, 'Loading...', '');
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
        adjust_app_token: adjustAppToken
      })
    });
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.detail||'Failed to load dashboard');

    _dashboardData = { google: data.google, applovin: data.applovin, mintegral: data.mintegral };
    _selectedSeries = { google: null, applovin: null, mintegral: null };

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

  // Render list with avg % spend
  const seriesWithAvg = data.series.map(s => {
    const avg = s.dataPct.reduce((a, b) => a + b, 0) / s.dataPct.length;
    return { name: s.name, avgPct: avg };
  }).sort((a, b) => b.avgPct - a.avgPct);

  listEl.innerHTML = seriesWithAvg.map((s, idx) => `
    <div class="dashboard-list-item" data-key="${key}" data-name="${escapeHtml(s.name)}" data-idx="${idx}">
      <span class="item-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
      <span class="item-pct">${s.avgPct.toFixed(1)}%</span>
    </div>
  `).join('');

  // Add click handlers
  listEl.querySelectorAll('.dashboard-list-item').forEach(item => {
    item.addEventListener('click', () => onListItemClick(key, item.dataset.name));
  });
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
