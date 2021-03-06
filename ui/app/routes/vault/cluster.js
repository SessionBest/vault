import { inject as service } from '@ember/service';
import { computed } from '@ember/object';
import { reject } from 'rsvp';
import Route from '@ember/routing/route';
import { task, timeout } from 'ember-concurrency';
import Ember from 'ember';
import ClusterRoute from 'vault/mixins/cluster-route';
import ModelBoundaryRoute from 'vault/mixins/model-boundary-route';

const POLL_INTERVAL_MS = 10000;

export default Route.extend(ModelBoundaryRoute, ClusterRoute, {
  namespaceService: service('namespace'),
  version: service(),
  permissions: service(),
  store: service(),
  auth: service(),
  currentCluster: service(),
  modelTypes: computed(function() {
    return ['node', 'secret', 'secret-engine'];
  }),

  queryParams: {
    namespaceQueryParam: {
      refreshModel: true,
    },
  },

  getClusterId(params) {
    const { cluster_name } = params;
    const cluster = this.modelFor('vault').findBy('name', cluster_name);
    return cluster ? cluster.get('id') : null;
  },

  async beforeModel() {
    const params = this.paramsFor(this.routeName);
    this.namespaceService.setNamespace(params.namespaceQueryParam);
    const id = this.getClusterId(params);
    if (id) {
      this.auth.setCluster(id);
      await this.permissions.getPaths.perform();
      return this.version.fetchFeatures();
    } else {
      return reject({ httpStatus: 404, message: 'not found', path: params.cluster_name });
    }
  },

  model(params) {
    const id = this.getClusterId(params);
    return this.store.findRecord('cluster', id);
  },

  poll: task(function*() {
    while (true) {
      // when testing, the polling loop causes promises to never settle so acceptance tests hang
      // to get around that, we just disable the poll in tests
      if (Ember.testing) {
        return;
      }
      yield timeout(POLL_INTERVAL_MS);
      try {
        yield this.controller.model.reload();
        yield this.transitionToTargetRoute();
      } catch (e) {
        // we want to keep polling here
      }
    }
  })
    .cancelOn('deactivate')
    .keepLatest(),

  afterModel(model, transition) {
    this._super(...arguments);
    this.currentCluster.setCluster(model);

    // Check that namespaces is enabled and if not,
    // clear the namespace by transition to this route w/o it
    if (this.namespaceService.path && !this.version.hasNamespaces) {
      return this.transitionTo(this.routeName, { queryParams: { namespace: '' } });
    }
    return this.transitionToTargetRoute(transition);
  },

  setupController() {
    this._super(...arguments);
    this.poll.perform();
  },

  actions: {
    error(e) {
      if (e.httpStatus === 503 && e.errors[0] === 'Vault is sealed') {
        this.refresh();
      }
      return true;
    },
  },
});
