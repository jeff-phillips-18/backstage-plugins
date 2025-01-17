import React from 'react';

import { CardTab, Content, Page, TabbedCard } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';

import { CircularProgress, Grid } from '@material-ui/core';
import _ from 'lodash';

import * as FilterHelper from '../../components/FilterList/FitlerHelper';
import { isMultiCluster, serverConfig } from '../../config';
import { getErrorString, kialiApiRef } from '../../services/Api';
import { computePrometheusRateParams } from '../../services/Prometheus';
import { KialiContext } from '../../store/Context';
import { KialiAppState } from '../../store/Store';
import {
  DEGRADED,
  FAILURE,
  Health,
  HEALTHY,
  NamespaceAppHealth,
  NamespaceServiceHealth,
  NamespaceWorkloadHealth,
  NOT_READY,
} from '../../types/Health';
import {
  CanaryUpgradeStatus,
  OutboundTrafficPolicy,
} from '../../types/IstioObjects';
import { IstiodResourceThresholds } from '../../types/IstioStatus';
import { MessageType } from '../../types/MessageCenter';
import { IstioMetricsOptions } from '../../types/MetricsOptions';
import { SortField } from '../../types/SortFilters';
import { nsWideMTLSStatus } from '../../types/TLSStatus';
import { PromisesRegistry } from '../../utils/CancelablePromises';
import { NamespaceInfo, NamespaceStatus } from './NamespaceInfo';
import { OverviewCard } from './OverviewCard';
import { switchType } from './OverviewHelper';
import {
  currentDirectionType,
  currentOverviewType,
  DirectionType,
  OverviewToolbar,
  OverviewType,
} from './OverviewToolbar';
import * as Sorts from './Sorts';

export const OverviewPage = (props: { entity?: boolean }) => {
  const kialiClient = useApi(kialiApiRef);
  const kialiState = React.useContext(KialiContext) as KialiAppState;
  const promises = new PromisesRegistry();
  const [namespaces, setNamespaces] = React.useState<NamespaceInfo[]>([]);
  const [outboundTrafficPolicy, setOutboundTrafficPolicy] =
    React.useState<OutboundTrafficPolicy>({});
  const [canaryUpgradeStatus, setCanaryUpgradeStatus] = React.useState<
    CanaryUpgradeStatus | undefined
  >(undefined);
  const [istiodResourceThresholds, setIstiodResourceThresholds] =
    React.useState<IstiodResourceThresholds>({ memory: 0, cpu: 0 });
  const [duration, setDuration] = React.useState<number>(
    FilterHelper.currentDuration(),
  );
  const [overviewType, setOverviewType] = React.useState<OverviewType>(
    currentOverviewType(),
  );
  const [directionType, setDirectionType] = React.useState<DirectionType>(
    currentDirectionType(),
  );

  const sortedNamespaces = (nss: NamespaceInfo[]) => {
    nss.sort((a, b) => {
      if (a.name === serverConfig.istioNamespace) return -1;
      if (b.name === serverConfig.istioNamespace) return 1;
      return a.name.localeCompare(b.name);
    });
    return nss;
  };

  const fetchHealthChunk = async (chunk: NamespaceInfo[]): Promise<void> => {
    const apiFunc = switchType(
      overviewType,
      kialiClient.getNamespaceAppHealth,
      kialiClient.getNamespaceServiceHealth,
      kialiClient.getNamespaceWorkloadHealth,
    );

    return Promise.all(
      chunk.map(async nsInfo => {
        const healthPromise: Promise<
          NamespaceAppHealth | NamespaceWorkloadHealth | NamespaceServiceHealth
        > = apiFunc(nsInfo.name, duration, nsInfo.cluster);
        return healthPromise.then(rs => ({ health: rs, nsInfo: nsInfo }));
      }),
    )
      .then(results => {
        results.forEach(result => {
          const nsStatus: NamespaceStatus = {
            inNotReady: [],
            inError: [],
            inWarning: [],
            inSuccess: [],
            notAvailable: [],
          };
          Object.keys(result.health).forEach(item => {
            const health: Health = result.health[item];
            const status = health.getGlobalStatus();
            if (status === FAILURE) {
              nsStatus.inError.push(item);
            } else if (status === DEGRADED) {
              nsStatus.inWarning.push(item);
            } else if (status === HEALTHY) {
              nsStatus.inSuccess.push(item);
            } else if (status === NOT_READY) {
              nsStatus.inNotReady.push(item);
            } else {
              nsStatus.notAvailable.push(item);
            }
          });
          result.nsInfo.status = nsStatus;
        });
      })
      .catch(err =>
        kialiState.alertUtils!.add(
          `Could not fetch health: ${getErrorString(err)}`,
        ),
      );
  };

  const fetchHealth = (
    nss: NamespaceInfo[],
    isAscending: boolean,
    sortField: SortField<NamespaceInfo>,
  ): void => {
    _.chunk(nss, 10).forEach(chunk => {
      promises
        .registerChained('healthchunks', undefined, () =>
          fetchHealthChunk(chunk),
        )
        .then(() => {
          let newNamespaces = nss.slice();
          if (sortField.id === 'health') {
            newNamespaces = Sorts.sortFunc(
              newNamespaces,
              sortField,
              isAscending,
            );
          }
          return nss;
        })
        .catch(error => {
          kialiState.alertUtils!.add(
            `Could not fetch health: ${getErrorString(error)}`,
          );
          if (error.isCanceled) {
            return [];
          }
          return error;
        });
    });
  };

  const fetchTLSChunk = async (chunk: NamespaceInfo[]): Promise<void> => {
    return Promise.all(
      chunk.map(async nsInfo => {
        return kialiClient
          .getNamespaceTls(nsInfo.name, nsInfo.cluster)
          .then(rs => ({ status: rs, nsInfo: nsInfo }));
      }),
    )
      .then(results => {
        results.forEach(result => {
          result.nsInfo.tlsStatus = {
            status: nsWideMTLSStatus(
              result.status.status,
              kialiState.meshTLSStatus.status,
            ),
            autoMTLSEnabled: result.status.autoMTLSEnabled,
            minTLS: result.status.minTLS,
          };
        });
      })
      .catch(err =>
        kialiState.alertUtils!.add(
          `Could not fetch TLS status: ${getErrorString(err)}`,
        ),
      );
  };

  const fetchTLS = (
    nss: NamespaceInfo[],
    isAscending: boolean,
    sortField: SortField<NamespaceInfo>,
  ): void => {
    _.chunk(nss, 10).forEach(chunk => {
      promises
        .registerChained('tlschunks', undefined, () => fetchTLSChunk(chunk))
        .then(() => {
          let newNamespaces = nss.slice();
          if (sortField.id === 'mtls') {
            newNamespaces = Sorts.sortFunc(
              newNamespaces,
              sortField,
              isAscending,
            );
          }
          return newNamespaces;
        });
    });
  };

  const fetchOutboundTrafficPolicyMode = () => {
    kialiClient
      .getOutboundTrafficPolicyMode()
      .then(response => {
        setOutboundTrafficPolicy({ mode: response.mode });
      })
      .catch(error => {
        kialiState.alertUtils!.addError(
          'Error fetching Mesh OutboundTrafficPolicy.Mode.',
          error,
          'default',
          MessageType.ERROR,
        );
      });
  };

  const fetchCanariesStatus = () =>
    kialiClient
      .getCanaryUpgradeStatus()
      .then(response => {
        setCanaryUpgradeStatus({
          currentVersion: response.currentVersion,
          upgradeVersion: response.upgradeVersion,
          migratedNamespaces: response.migratedNamespaces,
          pendingNamespaces: response.pendingNamespaces,
        });
      })
      .catch(error => {
        kialiState.alertUtils!.addError(
          'Error fetching canary upgrade status.',
          error,
          'default',
          MessageType.ERROR,
        );
      });

  const fetchIstiodResourceThresholds = () => {
    kialiClient
      .getIstiodResourceThresholds()
      .then(response => setIstiodResourceThresholds(response))
      .catch(error => {
        kialiState.alertUtils!.addError(
          'Error fetching Istiod resource thresholds.',
          error,
          'default',
          MessageType.ERROR,
        );
      });
  };

  const fetchValidationResultForCluster = async (
    nss: NamespaceInfo[],
    cluster: string,
  ) => {
    return Promise.all([
      kialiClient.getConfigValidations(cluster),
      kialiClient.getAllIstioConfigs([], [], false, '', '', cluster),
    ])
      .then(results => {
        nss.forEach(nsInfo => {
          if (
            nsInfo.cluster &&
            nsInfo.cluster === cluster &&
            (results[0] as any)[nsInfo.cluster]
          ) {
            // @ts-expect-error
            nsInfo.validations = results[0][nsInfo.cluster][nsInfo.name];
          }
          if (nsInfo.cluster && nsInfo.cluster === cluster) {
            nsInfo.istioConfig = results[1][nsInfo.name];
          }
        });
      })
      .catch(err =>
        kialiState.alertUtils!.add(
          `Could not fetch validations status: ${getErrorString(err)}`,
        ),
      );
  };

  const fetchValidations = (
    nss: NamespaceInfo[],
    isAscending: boolean,
    sortField: SortField<NamespaceInfo>,
  ) => {
    const uniqueClusters = new Set<string>();
    nss.forEach(namespace => {
      if (namespace.cluster) {
        uniqueClusters.add(namespace.cluster);
      }
    });

    uniqueClusters.forEach(cluster => {
      promises
        .registerChained('validation', undefined, () =>
          fetchValidationResultForCluster(nss, cluster),
        )
        .then(() => {
          let newNamespaces = nss.slice();
          if (sortField.id === 'validations') {
            newNamespaces = Sorts.sortFunc(
              newNamespaces,
              sortField,
              isAscending,
            );
          }
          return newNamespaces;
        });
    });
  };

  const fetchMetricsChunk = (chunk: NamespaceInfo[]) => {
    const rateParams = computePrometheusRateParams(duration, 10);
    const options: IstioMetricsOptions = {
      filters: ['request_count', 'request_error_count'],
      duration: duration,
      step: rateParams.step,
      rateInterval: rateParams.rateInterval,
      direction: directionType,
      reporter: directionType === 'inbound' ? 'destination' : 'source',
    };
    return Promise.all(
      chunk.map(nsInfo => {
        if (nsInfo.cluster && isMultiCluster) {
          options.clusterName = nsInfo.cluster;
        }
        return kialiClient
          .getNamespaceMetrics(nsInfo.name, options)
          .then(rs => {
            nsInfo.metrics = rs.request_count;
            nsInfo.errorMetrics = rs.request_error_count;
            if (nsInfo.name === serverConfig.istioNamespace) {
              nsInfo.controlPlaneMetrics = {
                istiod_proxy_time: rs.pilot_proxy_convergence_time,
                istiod_container_cpu: rs.container_cpu_usage_seconds_total,
                istiod_container_mem: rs.container_memory_working_set_bytes,
                istiod_process_cpu: rs.process_cpu_seconds_total,
                istiod_process_mem: rs.process_resident_memory_bytes,
              };
            }
            return nsInfo;
          });
      }),
    ).catch(err =>
      kialiState.alertUtils!.add(
        `Could not fetch metrics: ${getErrorString(err)}`,
      ),
    );
  };

  const fetchMetrics = (nss: NamespaceInfo[]) => {
    // debounce async for back-pressure, ten by ten
    _.chunk(nss, 10).forEach(chunk => {
      promises
        .registerChained('metricschunks', undefined, () =>
          fetchMetricsChunk(chunk),
        )
        .then(() => nss.slice());
    });
  };

  const filterActiveNamespaces = () => {
    const activeNs = kialiState.namespaces.activeNamespaces.map(ns => ns.name);
    return namespaces.filter(ns => activeNs.includes(ns.name));
  };

  const load = async () => {
    await kialiClient.getNamespaces().then(namespacesResponse => {
      const allNamespaces: NamespaceInfo[] = namespacesResponse.map(ns => {
        const previous = namespaces.find(prev => prev.name === ns.name);
        return {
          name: ns.name,
          cluster: ns.cluster,
          isAmbient: ns.isAmbient,
          status: previous ? previous.status : undefined,
          tlsStatus: previous ? previous.tlsStatus : undefined,
          metrics: previous ? previous.metrics : undefined,
          errorMetrics: previous ? previous.errorMetrics : undefined,
          validations: previous ? previous.validations : undefined,
          labels: ns.labels,
          annotations: ns.annotations,
          controlPlaneMetrics: previous
            ? previous.controlPlaneMetrics
            : undefined,
        };
      });

      // Calculate information
      const isAscending = FilterHelper.isCurrentSortAscending();
      const sortField = FilterHelper.currentSortField(Sorts.sortFields);
      const sortNs = sortedNamespaces(allNamespaces);
      if (!props.entity) {
        fetchHealth(sortNs, isAscending, sortField);
        fetchTLS(sortNs, isAscending, sortField);
        fetchValidations(sortNs, isAscending, sortField);
        fetchOutboundTrafficPolicyMode();
        fetchCanariesStatus();
        fetchIstiodResourceThresholds();
      }
      fetchMetrics(sortNs);
      promises.waitAll();
      setNamespaces(sortNs);
    });
  };

  React.useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, overviewType, directionType]);

  if (namespaces.length === 0) {
    return <CircularProgress />;
  }

  const overviewLinkInfo = { title: 'Go to Full Overview', link: '#' };

  return (
    <Page themeId="tool">
      <Content>
        {props.entity ? (
          <TabbedCard title="Overview" deepLink={overviewLinkInfo}>
            {filterActiveNamespaces().map(ns => (
              <CardTab label={ns.name} key={`card_ns_${ns.name}`}>
                <OverviewCard
                  entity
                  namespace={ns}
                  canaryUpgradeStatus={canaryUpgradeStatus}
                  istioAPIEnabled={
                    kialiState.statusState.istioEnvironment.istioAPIEnabled
                  }
                  type={overviewType}
                  direction={directionType}
                  duration={duration}
                  refreshInterval={kialiState.userSettings.refreshInterval}
                  certsInfo={kialiState.istioCertsInfo}
                  minTLS={kialiState.meshTLSStatus.minTLS}
                  istiodResourceThresholds={istiodResourceThresholds}
                  istioStatus={kialiState.istioStatus}
                  outboundTrafficPolicy={outboundTrafficPolicy}
                />
              </CardTab>
            ))}
          </TabbedCard>
        ) : (
          <>
            <OverviewToolbar
              onRefresh={() => load()}
              overviewType={overviewType}
              setOverviewType={setOverviewType}
              directionType={directionType}
              setDirectionType={setDirectionType}
              duration={duration}
              setDuration={setDuration}
            />
            <Grid container spacing={2}>
              {filterActiveNamespaces().map((ns, i) => (
                <Grid
                  key={`Card_${ns.name}_${i}`}
                  item
                  xs={ns.name === serverConfig.istioNamespace ? 12 : 4}
                >
                  <OverviewCard
                    namespace={ns}
                    canaryUpgradeStatus={canaryUpgradeStatus}
                    istioAPIEnabled={
                      kialiState.statusState.istioEnvironment.istioAPIEnabled
                    }
                    type={overviewType}
                    direction={directionType}
                    duration={duration}
                    refreshInterval={kialiState.userSettings.refreshInterval}
                    certsInfo={kialiState.istioCertsInfo}
                    minTLS={kialiState.meshTLSStatus.minTLS}
                    istiodResourceThresholds={istiodResourceThresholds}
                    istioStatus={kialiState.istioStatus}
                    outboundTrafficPolicy={outboundTrafficPolicy}
                  />
                </Grid>
              ))}
            </Grid>
          </>
        )}
      </Content>
    </Page>
  );
};
