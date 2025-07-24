import React, { useState } from 'react';
import './AgentDetails.css';
import PerformanceRubrics from '../PerformanceRubrics/PerformanceRubrics';
import { agentService } from '../../services/agentService';

// SVG Components
const WestIcon = () => <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M7.5 2L3.5 6L7.5 10" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const PersonIcon = () => <svg width="60" height="60" viewBox="0 0 60 60" fill="none"><path d="M30 30C37.1797 30 43 24.1797 43 17C43 9.8203 37.1797 4 30 4C22.8203 4 17 9.8203 17 17C17 24.1797 22.8203 30 30 30ZM30 37C20.3359 37 1 41.8359 1 51.5V56H59V51.5C59 41.8359 39.6641 37 30 37Z" fill="#666666"/></svg>;
const CallIcon = () => <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M18.3 14.1L15.6 13.4C15.1 13.3 14.6 13.4 14.2 13.7L12.4 15.5C9.6 14.1 5.9 10.4 4.5 7.6L6.3 5.8C6.6 5.4 6.7 4.9 6.6 4.4L5.9 1.7C5.7 0.7 4.8 0 3.8 0H2.2C1.1 0 0.1 0.9 0.2 2C0.9 11.8 8.2 19.1 18 19.8C19.1 19.9 20 18.9 20 17.8V16.2C20 15.2 19.3 14.3 18.3 14.1Z" fill="#000"/></svg>;


function AgentDetails({ agent, onBack }) {
  const [showRubrics, setShowRubrics] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [selectedPrograms, setSelectedPrograms] = useState(agent.programs || []);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const callHistory = agent.evaluations || [];
  
  const programOptions = ['National Hotline Program', 'Nebraska Crisis Program'];
  
  const handleProgramToggle = async (program) => {
    const newPrograms = selectedPrograms.includes(program)
      ? selectedPrograms.filter(p => p !== program)
      : [...selectedPrograms, program];
    
    setSelectedPrograms(newPrograms);
    await agentService.updateAgentPrograms(agent.contactId, newPrograms);
  };

  const handleFileClick = (call) => {
    setSelectedFile(call);
    setShowRubrics(true);
  };

  const handleBackFromRubrics = () => {
    setShowRubrics(false);
    setSelectedFile(null);
  };

  if (showRubrics && selectedFile) {
    return (
      <PerformanceRubrics 
        fileName={selectedFile.fileName}
        s3Url={selectedFile.s3Url || 'mock-url'}
        onBack={handleBackFromRubrics}
      />
    );
  }

  return (
    <div className="agent-details-container">
      {/* Header with back button */}
      <div className="agent-details-header">
        <div className="back-button" onClick={onBack}>
          <div className="back-icon-container">
            <WestIcon className="west-icon" />
          </div>
          <span className="back-text">Agent Details</span>
        </div>
      </div>
      
      <div className="agent-details-columns">
        {/* Left Column */}
        <div className="left-column">

          {/* Agent Profile Card */}
          <div className="profile-card">
            <div className="profile-avatar">
              <div className="avatar-background">
                {typeof agent.avatar === 'function' ? <agent.avatar /> : <img src={agent.avatar} alt="" />}
              </div>
              <div className="avatar-person-container">
                <PersonIcon className="avatar-person" />
              </div>
            </div>
            <h2 className="profile-name">{agent.name}</h2>
            <p className="profile-contact-id">Contact ID: {agent.contactId}</p>
            
            <div className="program-section">
              <label className="program-label">Programs:</label>
              <div className="program-dropdown">
                <div 
                  className="program-dropdown-trigger"
                  onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                >
                  <span>{selectedPrograms.length > 0 ? selectedPrograms.join(', ') : 'Select programs...'}</span>
                  <span className="dropdown-arrow">{isDropdownOpen ? '▲' : '▼'}</span>
                </div>
                {isDropdownOpen && (
                  <div className="program-dropdown-menu">
                    {programOptions.map(program => (
                      <div
                        key={program}
                        className={`program-option ${selectedPrograms.includes(program) ? 'selected' : ''}`}
                        onClick={() => handleProgramToggle(program)}
                      >
                        <input
                          type="checkbox"
                          checked={selectedPrograms.includes(program)}
                          readOnly
                        />
                        <span>{program}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div className="right-column">
          {/* Call History Card */}
          <div className="call-history-card">
            <div className="call-history-header">
              <div className="call-icon-container">
                <CallIcon className="call-icon" />
              </div>
              <h2 className="call-history-title">Call History</h2>
            </div>

            <div className="call-history-table">
              <div className="table-header">
                <div className="column file-name-column">File Name</div>
                <div className="column date-column">Date</div>
                <div className="column score-column">Score</div>
              </div>
              <div className="table-divider"></div>
              
              {callHistory.length > 0 ? callHistory.map((call, index) => (
                <div key={index} className="table-row-container">
                  <div className="table-row">
                    <div 
                      className="column file-name-column clickable-filename" 
                      onClick={() => handleFileClick(call)}
                    >
                      {call.fileName}
                    </div>
                    <div className="column date-column">{call.date}</div>
                    <div className="column score-column">{call.score}</div>
                  </div>
                  <div className="table-divider"></div>
                </div>
              )) : (
                <div className="table-row-container">
                  <div className="table-row">
                    <div className="column file-name-column">No call history available</div>
                    <div className="column date-column"></div>
                    <div className="column score-column"></div>
                  </div>
                  <div className="table-divider"></div>
                </div>
              )}
            </div>
          </div>

          {/* Total Cases Summary Card */}
          <div className="total-cases-card">
            <h2 className="total-cases-title">Total Cases</h2>
            <div className="total-cases-divider"></div>
            
            <div className="total-cases-content">
              <div className="cases-section">
                <p className="cases-count">{agent.totalCases}</p>
              </div>
              
              <div className="vertical-divider"></div>
              
              <div className="analysis-section">
                <h3 className="analysis-title">1st Half Year Analysis</h3>
                <p className="analysis-percentage">{agent.firstHalfAvg !== 'N/A' ? `${agent.firstHalfAvg}%` : 'N/A'}</p>
              </div>
              
              <div className="vertical-divider"></div>
              
              <div className="analysis-section">
                <h3 className="analysis-title">2nd Half Year Analysis</h3>
                <p className="analysis-percentage">{agent.secondHalfAvg !== 'N/A' ? `${agent.secondHalfAvg}%` : 'N/A'}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AgentDetails;