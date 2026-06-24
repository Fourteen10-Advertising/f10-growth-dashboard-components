/**
 * f10-analytics.js — F10 dashboard product analytics (PostHog)
 * Load via: <script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-growth-dashboard-components@vX.Y.Z/f10-analytics.js"></script>
 *
 * Load this BEFORE the shell/layout script. It exposes a tiny F10A facade that
 * the shell uses to identify the client and emit usage events. The dashboards
 * have no login, so the strongest identity signal we have is *which client's
 * dashboard* this is — that flows in via F10A.init({ client }).
 *
 * Config: the project API key and host below are shared across every client
 * dashboard (one PostHog project). A PostHog *project* key is a client-side,
 * write-only ingestion key — it ships in the page source of every PostHog site
 * by design, so it is safe to commit here. It is NOT a secret. A client can
 * override per-deployment by setting window.POSTHOG_KEY / window.POSTHOG_HOST
 * before this script runs.
 *
 *   F10A.init({ client: 'Acme', dashboardType: 'growth' });
 *   F10A.track('tab_viewed', { tab: 'overview' });
 */

(function (global) {
  /* ── Shared project config (one project for all client dashboards) ── */
  /* "F10 Dashboards" PostHog project (US cloud). If the key is ever blanked
   * out, F10A.init() no-ops with a console warning so dashboards keep working. */
  var POSTHOG_KEY_DEFAULT = 'phc_CoDmyZAiBMN3QHhTfH2q3Hk4wkHkARghLHK8RheRrTvp';
  var POSTHOG_HOST_DEFAULT = 'https://us.i.posthog.com';

  /* Official PostHog browser loader snippet (loads the SDK async from CDN). */
  !function (t, e) { var o, n, p, r; e.__SV || (window.posthog = e, e._i = [], e.init = function (i, s, a) { function g(t, e) { var o = e.split("."); 2 == o.length && (t = t[o[0]], e = o[1]), t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))) } } (p = t.createElement("script")).type = "text/javascript", p.crossOrigin = "anonymous", p.async = !0, p.src = s.api_host.replace(".i.posthog.com", "-assets.i.posthog.com") + "/static/array.js", (r = t.getElementsByTagName("script")[0]).parentNode.insertBefore(p, r); var u = e; for (void 0 !== a ? u = e[a] = [] : a = "posthog", u.people = u.people || [], u.toString = function (t) { var e = "posthog"; return "posthog" !== a && (e += "." + a), t || (e += " (stub)"), e }, u.people.toString = function () { return u.toString(1) + ".people (stub)" }, o = "init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId captureTraceFeedback captureTraceMetric".split(" "), n = 0; n < o.length; n++)g(u, o[n]); e._i.push([i, s, a]) }, e.__SV = 1) }(document, window.posthog || []);

  var F10A = {
    _ready: false,

    /** Initialise PostHog for this dashboard. Safe to call once per page. */
    init: function (opts) {
      opts = opts || {};
      var key = global.POSTHOG_KEY || POSTHOG_KEY_DEFAULT;
      var host = global.POSTHOG_HOST || POSTHOG_HOST_DEFAULT;
      var client = opts.client || 'Unknown';
      var dashboardType = opts.dashboardType || 'unknown';

      if (!key || key === '__POSTHOG_PROJECT_KEY__') {
        /* No key configured yet — do not throw, but do not stay silent either. */
        console.warn('[f10-analytics] PostHog key not configured; analytics disabled.');
        return;
      }

      try {
        global.posthog.init(key, {
          api_host: host,
          person_profiles: 'always',
          capture_pageview: true,
          autocapture: true,
          /* Session replay: record navigation, mask data-entry inputs. The
           * dashboard shows the client's own performance data back to them; we
           * mask inputs (date pickers, filters) but keep nav/charts visible so
           * we can see *how* people move around. */
          disable_session_recording: false,
          session_recording: {
            maskAllInputs: true,
            maskTextSelector: '[data-ph-mask]'
          },
          loaded: function (ph) {
            /* Attribute every event + replay to the client. */
            ph.register({ client: client, dashboard_type: dashboardType });
            ph.group('client', client, { name: client });
            /* Let F10's own QA traffic be filtered out: append ?viewer=internal */
            try {
              var v = new URLSearchParams(global.location.search).get('viewer');
              if (v) ph.setPersonProperties({ viewer_type: v });
            } catch (e) {
              console.warn('[f10-analytics] viewer param parse failed', e);
            }
          }
        });
        this._ready = true;
      } catch (e) {
        /* Never let analytics wiring break a client dashboard. Log loudly. */
        console.error('[f10-analytics] PostHog init failed', e);
      }
    },

    /** Emit a custom event. No-ops (with a warning) if PostHog is unavailable. */
    track: function (event, props) {
      if (!this._ready || !global.posthog || typeof global.posthog.capture !== 'function') {
        return;
      }
      try {
        global.posthog.capture(event, props || {});
      } catch (e) {
        console.error('[f10-analytics] capture failed for ' + event, e);
      }
    }
  };

  global.F10A = F10A;
})(window);
